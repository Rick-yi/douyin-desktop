package com.zmtjl.license.service;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.domain.JumpCard;
import com.zmtjl.license.domain.JumpClick;
import com.zmtjl.license.repo.JumpCardRepository;
import com.zmtjl.license.repo.JumpClickRepository;
import com.zmtjl.license.web.ApiException;
import com.zmtjl.license.web.JumpCardDtos.*;
import com.zmtjl.license.web.PageResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 跳转卡：后台维护卡片 + 对外短链跳转 + 点击统计
 *
 * 短链格式：{publicBaseUrl}/r/{code}
 * 已经发出去的短链不会因为改目标地址而失效。
 */
@Service
public class JumpCardService {
    private static final Logger log = LoggerFactory.getLogger(JumpCardService.class);
    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern CODE_PATTERN = Pattern.compile("^[A-Z0-9_-]{4,16}$");
    private static final int MAX_URL = 1024;

    private final JumpCardRepository cardRepo;
    private final JumpClickRepository clickRepo;
    private final AppProperties props;
    private final Clock clock;

    public JumpCardService(JumpCardRepository cardRepo,
                           JumpClickRepository clickRepo,
                           AppProperties props,
                           Clock clock) {
        this.cardRepo = cardRepo;
        this.clickRepo = clickRepo;
        this.props = props;
        this.clock = clock;
    }

    // ══════════════ 管理端 ══════════════

    public Object list(Integer page, Integer size) {
        if (page == null) {
            return cardRepo.findAllByOrderByCreatedAtDesc().stream().map(this::toView).toList();
        }
        int p = Math.max(0, page);
        int s = Math.max(1, Math.min(200, size == null ? 50 : size));
        Page<JumpCard> result = cardRepo.findAllByOrderByCreatedAtDesc(PageRequest.of(p, s));
        return PageResponse.of(result, this::toView);
    }

    public JumpCardDetail detail(String id) {
        JumpCard card = require(id);
        List<JumpClickView> clicks = clickRepo.findTop100ByCardIdOrderByClickedAtDesc(id)
                .stream().map(this::toClickView).toList();
        return new JumpCardDetail(toView(card), clickRepo.countByCardId(id), clicks);
    }

    @Transactional
    public JumpCardView create(JumpCardUpsertRequest req) {
        long now = clock.millis();
        JumpCard card = new JumpCard();
        card.setId(UUID.randomUUID().toString());
        card.setCode(resolveNewCode(req.code()));
        apply(card, req);
        card.setClickCount(0);
        card.setCreatedAt(now);
        card.setUpdatedAt(now);
        return toView(cardRepo.save(card));
    }

    @Transactional
    public JumpCardView update(String id, JumpCardUpsertRequest req) {
        JumpCard card = require(id);
        String wanted = normalizeCodeOrNull(req.code());
        if (wanted != null && !wanted.equals(card.getCode())) {
            if (cardRepo.existsByCode(wanted)) {
                throw new ApiException("CODE_EXISTS", "短链标识已被占用");
            }
            card.setCode(wanted);
        }
        apply(card, req);
        card.setUpdatedAt(clock.millis());
        return toView(cardRepo.save(card));
    }

    @Transactional
    public void delete(String id) {
        JumpCard card = require(id);
        clickRepo.deleteByCardId(id);
        cardRepo.delete(card);
    }

    // ══════════════ 公开端 ══════════════

    public List<PublicJumpCardView> publicList(String groupName) {
        List<JumpCard> cards = (groupName == null || groupName.isBlank())
                ? cardRepo.findByStatusOrderByCreatedAtDesc(JumpCard.STATUS_ACTIVE)
                : cardRepo.findByStatusAndGroupNameOrderByCreatedAtDesc(JumpCard.STATUS_ACTIVE, groupName.trim());
        return cards.stream().map(this::toPublicView).toList();
    }

    public Optional<PublicJumpCardView> publicGet(String code) {
        return cardRepo.findByCode(normalizeCode(code))
                .filter(JumpCard::isActive)
                .map(this::toPublicView);
    }

    /** 短链跳转用：只返回启用状态的卡片 */
    public Optional<JumpCard> findActive(String code) {
        return cardRepo.findByCode(normalizeCode(code)).filter(JumpCard::isActive);
    }

    /**
     * 记录一次点击。
     *
     * 独立事务，统计失败不能影响跳转本身。IP 只存 HMAC 指纹，
     * Referer 去掉 query/fragment，避免把 token、来源参数长期落库。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordClick(String cardId, String code, String ip, String userAgent, String referer) {
        try {
            long now = clock.millis();
            String ipHash = fingerprintIp(ip);
            int dedupe = props.getJumpClickDedupeSeconds();
            if (dedupe > 0 && ipHash != null
                    && clickRepo.existsByCardIdAndIpAndClickedAtAfter(
                            cardId, ipHash, now - dedupe * 1000L)) {
                return;
            }
            JumpClick click = new JumpClick();
            click.setId(UUID.randomUUID().toString());
            click.setCardId(cardId);
            click.setCode(code);
            click.setIp(ipHash);
            click.setUserAgent(truncate(userAgent, 512));
            click.setReferer(sanitizeReferer(referer));
            click.setClickedAt(now);
            clickRepo.save(click);

            cardRepo.incrementClick(cardId, now);
        } catch (Exception e) {
            log.warn("记录跳转卡点击失败 card={} code={}: {}", cardId, code, e.getMessage());
        }
    }

    /** 每天清理过期的点击明细，避免 IP/UA 长期留存 */
    @Scheduled(cron = "0 30 3 * * *")
    @Transactional
    public void cleanupOldClicks() {
        int days = props.getJumpClickRetentionDays();
        if (days <= 0) return;
        long cutoff = clock.millis() - days * 86_400_000L;
        long removed = clickRepo.deleteByClickedAtBefore(cutoff);
        if (removed > 0) log.info("清理跳转卡点击明细 {} 条（保留 {} 天）", removed, days);
    }

    public String shortUrl(String code) {
        String base = props.getPublicBaseUrl();
        if (base == null || base.isBlank()) base = "http://127.0.0.1:8089";
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/r/" + code;
    }

    // ══════════════ 内部 ══════════════

    private void apply(JumpCard card, JumpCardUpsertRequest req) {
        card.setName(required(req.name(), "名称", 128));
        String targetType = normalizeTargetType(req.targetType());
        card.setTargetType(targetType);
        if (JumpCard.TARGET_WECHAT_QR.equals(targetType)) {
            card.setQrImageUrl(normalizeUrl(req.qrImageUrl(), "二维码图片", true));
            card.setTargetUrl("");
        } else if (JumpCard.TARGET_WECOM.equals(targetType)) {
            card.setTargetUrl(normalizeWeComUrl(req.targetUrl()));
            card.setQrImageUrl(normalizeUrl(req.qrImageUrl(), "二维码图片", false));
        } else {
            card.setQrImageUrl(null);
            card.setTargetUrl(normalizeUrl(req.targetUrl(), "目标地址", true));
        }
        card.setTitle(optional(req.title(), 128));
        card.setDescription(optional(req.description(), 255));
        card.setCoverUrl(normalizeUrl(req.coverUrl(), "封面图地址", false));
        card.setGroupName(req.groupName() == null || req.groupName().isBlank()
                ? "默认" : required(req.groupName(), "分组", 64));
        card.setStatus(normalizeStatus(req.status()));
    }

    private JumpCard require(String id) {
        return cardRepo.findById(id)
                .orElseThrow(() -> new ApiException("JUMP_CARD_NOT_FOUND", "跳转卡不存在", HttpStatus.NOT_FOUND));
    }

    private String resolveNewCode(String wanted) {
        String normalized = normalizeCodeOrNull(wanted);
        if (normalized != null) {
            if (cardRepo.existsByCode(normalized)) {
                throw new ApiException("CODE_EXISTS", "短链标识已被占用");
            }
            return normalized;
        }
        for (int i = 0; i < 8; i++) {
            String code = randomCode(8);
            if (!cardRepo.existsByCode(code)) return code;
        }
        throw new ApiException("CODE_GENERATE_FAILED", "短链标识生成失败，请重试");
    }

    private static String normalizeCodeOrNull(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String code = raw.trim().toUpperCase(Locale.ROOT);
        if (!CODE_PATTERN.matcher(code).matches()) {
            throw new ApiException("CODE_INVALID",
                    "短链标识只能包含字母、数字、下划线、中划线，长度 4-16");
        }
        return code;
    }

    private static String normalizeCode(String raw) {
        String code = raw == null ? "" : raw.trim().toUpperCase(Locale.ROOT);
        if (!CODE_PATTERN.matcher(code).matches()) {
            throw new ApiException("CODE_INVALID", "短链标识无效", HttpStatus.NOT_FOUND);
        }
        return code;
    }

    private static String normalizeTargetType(String raw) {
        if (raw == null || raw.isBlank()) return JumpCard.TARGET_URL;
        String type = raw.trim().toLowerCase(Locale.ROOT);
        if (!JumpCard.TARGET_URL.equals(type)
                && !JumpCard.TARGET_WECHAT_QR.equals(type)
                && !JumpCard.TARGET_WECOM.equals(type)) {
            throw new ApiException("TARGET_TYPE_INVALID", "卡片类型只能是 url、wechat_qr 或 wecom");
        }
        return type;
    }

    private static String normalizeStatus(String raw) {
        if (raw == null || raw.isBlank()) return JumpCard.STATUS_ACTIVE;
        String s = raw.trim().toLowerCase(Locale.ROOT);
        if (!JumpCard.STATUS_ACTIVE.equals(s) && !JumpCard.STATUS_DISABLED.equals(s)) {
            throw new ApiException("STATUS_INVALID", "状态只能是 active 或 disabled");
        }
        return s;
    }

    /** 企业微信「联系我」链接：允许 https，也允许 weixin:// / wxwork:// 唤起链接 */
    private static String normalizeWeComUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            throw new ApiException("URL_REQUIRED", "企业微信联系我链接不能为空");
        }
        if (value.length() > MAX_URL) {
            throw new ApiException("URL_TOO_LONG", "企业微信链接不能超过 " + MAX_URL + " 个字符");
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (scheme == null) throw new IllegalArgumentException("bad scheme");
            String s = scheme.toLowerCase(Locale.ROOT);
            if ("http".equals(s) || "https".equals(s)) {
                if (uri.getHost() == null) throw new IllegalArgumentException("bad host");
                return value;
            }
            if ("weixin".equals(s) || "wxwork".equals(s)) {
                return value;
            }
            throw new IllegalArgumentException("bad scheme");
        } catch (Exception e) {
            throw new ApiException("URL_INVALID",
                    "企业微信链接必须是 https://、weixin:// 或 wxwork:// 地址");
        }
    }

    private static String normalizeUrl(String raw, String label, boolean required) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            if (required) throw new ApiException("URL_REQUIRED", label + "不能为空");
            return null;
        }
        if (value.length() > MAX_URL) {
            throw new ApiException("URL_TOO_LONG", label + "不能超过 " + MAX_URL + " 个字符");
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (scheme == null
                    || (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))
                    || uri.getHost() == null) {
                throw new IllegalArgumentException("bad scheme");
            }
        } catch (Exception e) {
            throw new ApiException("URL_INVALID", label + "必须是完整的 http:// 或 https:// 地址");
        }
        return value;
    }

    /** IP 只保留带密钥的 HMAC 指纹，仍可用于去重，但无法直接还原地址。 */
    private String fingerprintIp(String ip) {
        if (ip == null || ip.isBlank()) return null;
        String secret = props.getKeyHmacSecret();
        if (secret == null || secret.isBlank()) secret = "zmtjl-jump-click-fingerprint";
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(
                    mac.doFinal(ip.trim().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            log.warn("生成点击 IP 指纹失败: {}", e.getMessage());
            return null;
        }
    }

    /** 来源地址只保留 scheme+host+path，去掉可能带 token 的 query/fragment。 */
    private static String sanitizeReferer(String referer) {
        if (referer == null || referer.isBlank()) return null;
        String value = referer.trim();
        int cut = value.length();
        int query = value.indexOf('?');
        if (query >= 0) cut = Math.min(cut, query);
        int fragment = value.indexOf('#');
        if (fragment >= 0) cut = Math.min(cut, fragment);
        value = value.substring(0, cut);
        return value.isBlank() ? null : truncate(value, MAX_URL);
    }

    private static String required(String raw, String label, int max) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) throw new ApiException("INVALID_ARGUMENT", label + "不能为空");
        return truncate(v, max);
    }

    private static String optional(String raw, int max) {
        String v = raw == null ? "" : raw.trim();
        return v.isEmpty() ? null : truncate(v, max);
    }

    private static String truncate(String v, int max) {
        if (v == null) return null;
        return v.length() <= max ? v : v.substring(0, max);
    }

    private static String randomCode(int len) {
        StringBuilder sb = new StringBuilder(len);
        for (int i = 0; i < len; i++) {
            sb.append(ALPHABET[RANDOM.nextInt(ALPHABET.length)]);
        }
        return sb.toString();
    }

    private JumpCardView toView(JumpCard c) {
        return new JumpCardView(
                c.getId(), c.getCode(), c.getName(), c.getTargetType(),
                c.getTargetUrl(), c.getQrImageUrl(),
                c.getTitle(), c.getDescription(), c.getCoverUrl(), c.getGroupName(),
                c.getStatus(), c.getClickCount(), c.getLastClickAt(),
                shortUrl(c.getCode()), c.getCreatedAt(), c.getUpdatedAt());
    }

    private PublicJumpCardView toPublicView(JumpCard c) {
        return new PublicJumpCardView(
                c.getCode(), c.getName(), c.getTargetType(), c.getTitle(), c.getDescription(),
                c.getCoverUrl(), c.getGroupName(), shortUrl(c.getCode()));
    }

    private JumpClickView toClickView(JumpClick c) {
        return new JumpClickView(c.getId(), c.getIp(), c.getUserAgent(), c.getReferer(), c.getClickedAt());
    }
}
