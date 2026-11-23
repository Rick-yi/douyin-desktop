package com.zmtjl.license.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.domain.*;
import com.zmtjl.license.repo.*;
import com.zmtjl.license.service.pay.PaymentChannel;
import com.zmtjl.license.web.ApiException;
import com.zmtjl.license.web.PageResponse;
import com.zmtjl.license.web.LicenseDtos.GeneratedKey;
import com.zmtjl.license.web.ShopDtos.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 商城：商品、订单、支付回调、发卡
 *
 * 支付渠道通过 PaymentChannel 抽象接入，业务逻辑与具体渠道无关。
 */
@Service
public class ShopService {
    private static final Logger log = LoggerFactory.getLogger(ShopService.class);
    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private final ProductRepository productRepo;
    private final ShopOrderRepository orderRepo;
    private final PaymentEventRepository eventRepo;
    private final PlanRepository planRepo;
    private final LicenseKeyRepository keyRepo;
    private final EventLogRepository logRepo;
    private final AdminService adminService;
    private final OrderCrypto crypto;
    private final AppProperties props;
    private final Clock clock;
    private final ObjectMapper mapper;
    private final Map<String, PaymentChannel> channels;

    public ShopService(ProductRepository productRepo,
                       ShopOrderRepository orderRepo,
                       PaymentEventRepository eventRepo,
                       PlanRepository planRepo,
                       LicenseKeyRepository keyRepo,
                       EventLogRepository logRepo,
                       AdminService adminService,
                       OrderCrypto crypto,
                       AppProperties props,
                       Clock clock,
                       ObjectMapper mapper,
                       List<PaymentChannel> channels) {
        this.productRepo = productRepo;
        this.orderRepo = orderRepo;
        this.eventRepo = eventRepo;
        this.planRepo = planRepo;
        this.keyRepo = keyRepo;
        this.logRepo = logRepo;
        this.adminService = adminService;
        this.crypto = crypto;
        this.props = props;
        this.clock = clock;
        this.mapper = mapper;
        this.channels = channels.stream()
                .collect(Collectors.toMap(PaymentChannel::code, c -> c, (a, b) -> a));
    }

    // ══════════════ 公开商城 ══════════════

    public List<ProductView> listProducts() {
        return productRepo.findByStatusOrderByPriceCentsAsc(Product.STATUS_ACTIVE)
                .stream().map(this::toView).toList();
    }

    public List<ChannelView> listChannels() {
        return enabledChannelCodes().stream().map(ChannelView::new).toList();
    }

    @Transactional
    public OrderCreated createOrder(String productId, String channelCode, String note) {
        Product product = productRepo.findById(productId)
                .orElseThrow(() -> new ApiException("PRODUCT_NOT_FOUND", "商品不存在", HttpStatus.NOT_FOUND));
        if (!Product.STATUS_ACTIVE.equals(product.getStatus())) {
            throw new ApiException("PRODUCT_DISABLED", "商品已下架");
        }
        if (product.getPriceCents() <= 0) {
            throw new ApiException("PRICE_INVALID", "商品价格未配置");
        }
        PaymentChannel channel = requireChannel(channelCode);

        long now = clock.millis();
        ShopOrder o = new ShopOrder();
        o.setId(UUID.randomUUID().toString());
        o.setOutTradeNo("O" + random(20));
        o.setProductId(product.getId());
        o.setAmountCents(product.getPriceCents());
        o.setChannel(channel.code());
        o.setStatus(ShopOrder.STATUS_CREATED);
        o.setDeliveryToken(random(40).toLowerCase(Locale.ROOT));
        o.setBuyerNote(note == null ? null : note.substring(0, Math.min(255, note.length())));
        o.setExpiresAt(now + props.getOrderExpireMinutes() * 60_000L);
        o.setCreatedAt(now);
        orderRepo.save(o);

        PaymentChannel.CreatedPayment pay = channel.createPayment(o, product);
        return new OrderCreated(o.getOutTradeNo(), o.getAmountCents(), o.getChannel(), o.getStatus(),
                pay == null ? null : pay.payUrl(),
                pay == null ? null : pay.qrCode(),
                o.getDeliveryToken(), o.getExpiresAt());
    }

    @Transactional
    public BuyerOrderView getBuyerOrder(String outTradeNo, String token) {
        ShopOrder o = assertBuyer(outTradeNo, token);
        if (ShopOrder.STATUS_CREATED.equals(o.getStatus()) && o.getExpiresAt() < clock.millis()) {
            o.setStatus(ShopOrder.STATUS_CLOSED);
            o.setClosedAt(clock.millis());
            orderRepo.save(o);
        }
        Product product = productRepo.findById(o.getProductId()).orElse(null);
        Plan plan = product == null ? null : planRepo.findByCode(product.getPlanCode()).orElse(null);
        String key = o.isPaid() ? crypto.decrypt(o.getKeyCipher()) : null;
        Integer days = product == null ? null
                : (product.getDurationDays() != null ? product.getDurationDays()
                : (plan == null ? null : plan.getDurationDays()));
        return new BuyerOrderView(o.getOutTradeNo(), o.getStatus(), o.getAmountCents(), o.getChannel(),
                product == null ? null : product.getName(),
                product == null ? null : product.getPlanCode(),
                days, key, o.getPaidAt(), o.getExpiresAt(), o.getCreatedAt());
    }

    /** 校验订单归属，供 mock 收银台复用 */
    public ShopOrder assertBuyer(String outTradeNo, String token) {
        ShopOrder o = orderRepo.findByOutTradeNo(outTradeNo)
                .orElseThrow(() -> new ApiException("ORDER_NOT_FOUND", "订单不存在", HttpStatus.NOT_FOUND));
        if (token == null || !MessageDigest.isEqual(
                token.getBytes(StandardCharsets.UTF_8),
                o.getDeliveryToken().getBytes(StandardCharsets.UTF_8))) {
            throw new ApiException("ORDER_TOKEN_INVALID", "订单凭证无效", HttpStatus.FORBIDDEN);
        }
        return o;
    }

    // ══════════════ 支付回调 ══════════════

    @Transactional
    public String handleNotify(String channelCode, String rawBody,
                               Map<String, String> params, Map<String, String> headers) {
        PaymentChannel channel = requireChannel(channelCode);
        PaymentChannel.NotifyPayload p = channel.verifyNotify(rawBody, params, headers);

        ShopOrder o = orderRepo.findForUpdate(p.outTradeNo())
                .orElseThrow(() -> new ApiException("ORDER_NOT_FOUND", "订单不存在"));
        if (p.amountCents() != o.getAmountCents()) {
            log.warn("支付金额不一致: order={} expect={} got={}", o.getOutTradeNo(),
                    o.getAmountCents(), p.amountCents());
            throw new ApiException("AMOUNT_MISMATCH", "支付金额与订单不一致");
        }
        if (o.isPaid()) {
            // 已经处理过（重复通知）
            return channel.ackBody();
        }
        if (eventRepo.existsByChannelAndEventId(channel.code(), p.eventId())) {
            return channel.ackBody();
        }

        PaymentEvent ev = new PaymentEvent();
        ev.setId(UUID.randomUUID().toString());
        ev.setChannel(channel.code());
        ev.setEventId(p.eventId());
        ev.setOutTradeNo(o.getOutTradeNo());
        ev.setAmountCents(p.amountCents());
        ev.setRaw(p.raw());
        ev.setCreatedAt(clock.millis());
        try {
            eventRepo.saveAndFlush(ev);
        } catch (DataIntegrityViolationException dup) {
            // 并发重复通知：另一个事务已经处理
            return channel.ackBody();
        }

        settle(o, p.transactionId());
        return channel.ackBody();
    }

    /** 支付成功 → 发卡（调用方必须已持有订单行锁） */
    private void settle(ShopOrder o, String transactionId) {
        if (o.isPaid()) return;
        if (ShopOrder.STATUS_CANCELLED.equals(o.getStatus())
                || ShopOrder.STATUS_REFUNDED.equals(o.getStatus())) {
            throw new ApiException("ORDER_NOT_PAYABLE", "订单状态不允许支付");
        }
        Product product = productRepo.findById(o.getProductId())
                .orElseThrow(() -> new ApiException("PRODUCT_NOT_FOUND", "商品不存在"));

        GeneratedKey gk = adminService.issueKey(product.getPlanCode(), product.getDurationDays(),
                "shop:" + o.getOutTradeNo());

        long now = clock.millis();
        o.setStatus(ShopOrder.STATUS_PAID);
        o.setTransactionId(transactionId);
        o.setKeyId(gk.id());
        o.setKeyCipher(crypto.encrypt(gk.key()));
        o.setPaidAt(now);
        o.setDeliveredAt(now);
        o.setClosedAt(null);
        orderRepo.save(o);
        logEvent("order_paid", o, Map.of("amountCents", o.getAmountCents(),
                "channel", o.getChannel()));
    }

    // ══════════════ 管理端 ══════════════

    @Transactional
    public Object adminList(String status, Integer page, Integer size) {
        orderRepo.closeExpired(clock.millis());
        if (page == null) {
            List<ShopOrder> list = (status == null || status.isBlank())
                    ? orderRepo.findTop100ByOrderByCreatedAtDesc()
                    : orderRepo.findTop100ByStatusOrderByCreatedAtDesc(status);
            return list.stream().map(this::toAdminView).toList();
        }
        int p = Math.max(0, page);
        int s = Math.max(1, Math.min(200, size == null ? 50 : size));
        PageRequest pr = PageRequest.of(p, s);
        Page<ShopOrder> result = (status == null || status.isBlank())
                ? orderRepo.findAllByOrderByCreatedAtDesc(pr)
                : orderRepo.findByStatusOrderByCreatedAtDesc(status, pr);
        return PageResponse.of(result, this::toAdminView);
    }

    public AdminOrderView adminDetail(String outTradeNo) {
        return toAdminView(mustGet(outTradeNo));
    }

    /** 客服找回卡密（仅管理端） */
    public String adminRevealKey(String outTradeNo) {
        ShopOrder o = mustGet(outTradeNo);
        if (!o.isPaid()) throw new ApiException("ORDER_NOT_PAID", "订单未支付");
        return crypto.decrypt(o.getKeyCipher());
    }

    @Transactional
    public AdminOrderView adminMarkPaid(String outTradeNo, String transactionId) {
        ShopOrder o = orderRepo.findForUpdate(outTradeNo)
                .orElseThrow(() -> new ApiException("ORDER_NOT_FOUND", "订单不存在", HttpStatus.NOT_FOUND));
        settle(o, transactionId == null || transactionId.isBlank()
                ? "MANUAL-" + System.currentTimeMillis() : transactionId);
        return toAdminView(o);
    }

    @Transactional
    public AdminOrderView adminCancel(String outTradeNo) {
        ShopOrder o = orderRepo.findForUpdate(outTradeNo)
                .orElseThrow(() -> new ApiException("ORDER_NOT_FOUND", "订单不存在", HttpStatus.NOT_FOUND));
        if (!ShopOrder.STATUS_CREATED.equals(o.getStatus())) {
            throw new ApiException("ORDER_NOT_CANCELLABLE", "只有未支付的订单可以取消");
        }
        o.setStatus(ShopOrder.STATUS_CANCELLED);
        o.setClosedAt(clock.millis());
        orderRepo.save(o);
        return toAdminView(o);
    }

    @Transactional
    public RefundResult adminRefund(String outTradeNo) {
        ShopOrder o = orderRepo.findForUpdate(outTradeNo)
                .orElseThrow(() -> new ApiException("ORDER_NOT_FOUND", "订单不存在", HttpStatus.NOT_FOUND));
        if (!o.isPaid()) {
            throw new ApiException("ORDER_NOT_PAID", "只有已支付订单可以退款");
        }
        o.setStatus(ShopOrder.STATUS_REFUNDED);
        orderRepo.save(o);

        boolean revoked = false;
        String message = "已标记退款";
        LicenseKey key = o.getKeyId() == null ? null : keyRepo.findById(o.getKeyId()).orElse(null);
        if (key != null && LicenseKey.STATUS_UNUSED.equals(key.getStatus())) {
            adminService.revoke(key.getId());
            revoked = true;
            message = "已标记退款，未使用的卡密已作废";
        } else if (key != null) {
            message = "已标记退款；卡密已被用户激活，未作废，请人工处理";
        }
        logEvent("order_refunded", o, Map.of("keyRevoked", revoked));
        return new RefundResult(o.getOutTradeNo(), o.getStatus(), revoked, message);
    }

    // ══════════════ 管理端商品 ══════════════

    public List<ProductView> adminProducts() {
        return productRepo.findAll().stream()
                .sorted(Comparator.comparingLong(Product::getPriceCents))
                .map(this::toView).toList();
    }

    @Transactional
    public ProductView upsertProduct(String id, ProductUpsertRequest req) {
        Plan plan = planRepo.findByCode(req.planCode())
                .orElseThrow(() -> new ApiException("PLAN_NOT_FOUND", "套餐不存在: " + req.planCode()));
        Product p = id == null ? null : productRepo.findById(id).orElse(null);
        if (p == null) {
            if (productRepo.findByCode(req.code()).isPresent()) {
                throw new ApiException("PRODUCT_CODE_EXISTS", "商品编码已存在");
            }
            p = new Product();
            p.setId(UUID.randomUUID().toString());
            p.setCreatedAt(clock.millis());
        }
        p.setCode(req.code());
        p.setName(req.name());
        p.setPlanCode(plan.getCode());
        p.setPriceCents(req.priceCents());
        p.setDurationDays(req.durationDays());
        p.setStatus(req.status() == null || req.status().isBlank()
                ? Product.STATUS_ACTIVE : req.status());
        productRepo.save(p);
        return toView(p);
    }

    // ══════════════ 内部 ══════════════

    private ShopOrder mustGet(String outTradeNo) {
        return orderRepo.findByOutTradeNo(outTradeNo)
                .orElseThrow(() -> new ApiException("ORDER_NOT_FOUND", "订单不存在", HttpStatus.NOT_FOUND));
    }

    private PaymentChannel requireChannel(String code) {
        if (code == null || code.isBlank()) throw new ApiException("CHANNEL_REQUIRED", "请选择支付渠道");
        PaymentChannel ch = channels.get(code);
        if (ch == null) throw new ApiException("CHANNEL_NOT_FOUND", "不支持的支付渠道: " + code);
        if (!enabledChannelCodes().contains(code)) {
            throw new ApiException("CHANNEL_DISABLED", "支付渠道未启用: " + code);
        }
        return ch;
    }

    private Set<String> enabledChannelCodes() {
        Set<String> out = new LinkedHashSet<>();
        for (String raw : String.valueOf(props.getPayChannels()).split(",")) {
            String c = raw.trim();
            if (c.isEmpty() || !channels.containsKey(c)) continue;
            if ("mock".equals(c) && (props.getPayMockSecret() == null || props.getPayMockSecret().isBlank())) {
                continue;
            }
            out.add(c);
        }
        return out;
    }

    private ProductView toView(Product p) {
        int deviceLimit = planRepo.findByCode(p.getPlanCode()).map(Plan::getDeviceLimit).orElse(0);
        return new ProductView(p.getId(), p.getCode(), p.getName(), p.getPlanCode(),
                p.getPriceCents(), p.getDurationDays(), deviceLimit, p.getStatus());
    }

    private AdminOrderView toAdminView(ShopOrder o) {
        Product product = productRepo.findById(o.getProductId()).orElse(null);
        String masked = null;
        if (o.isPaid() && o.getKeyCipher() != null) {
            try {
                String key = crypto.decrypt(o.getKeyCipher());
                masked = key.length() > 10 ? key.substring(0, 9) + "…" + key.substring(key.length() - 4) : "…";
            } catch (Exception e) {
                masked = "解密失败";
            }
        }
        return new AdminOrderView(o.getOutTradeNo(),
                product == null ? null : product.getName(),
                product == null ? null : product.getPlanCode(),
                o.getAmountCents(), o.getChannel(), o.getStatus(),
                o.getTransactionId(), o.getKeyId(), masked, o.getBuyerNote(),
                o.getPaidAt(), o.getDeliveredAt(), o.getExpiresAt(), o.getCreatedAt());
    }

    private void logEvent(String type, ShopOrder o, Map<String, Object> meta) {
        try {
            EventLog e = new EventLog();
            e.setId(UUID.randomUUID().toString());
            e.setType(type);
            e.setKeyId(o.getKeyId());
            e.setMetaJson(mapper.writeValueAsString(meta));
            e.setCreatedAt(clock.millis());
            logRepo.save(e);
        } catch (Exception ignored) {
        }
    }

    private static String random(int len) {
        StringBuilder sb = new StringBuilder(len);
        for (int i = 0; i < len; i++) sb.append(ALPHABET[RANDOM.nextInt(ALPHABET.length)]);
        return sb.toString();
    }
}
