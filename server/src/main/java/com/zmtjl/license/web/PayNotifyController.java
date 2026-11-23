package com.zmtjl.license.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.domain.ShopOrder;
import com.zmtjl.license.service.ShopService;
import com.zmtjl.license.service.pay.MockPaymentChannel;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * 支付回调 + mock 收银台
 *
 * 真实渠道（ZPay/微信/支付宝）以后只需要实现 PaymentChannel，
 * 然后往 app.pay.pay-channels 里加 code，这里的路由不用改。
 */
@RestController
@RequestMapping("/v1/pay")
public class PayNotifyController {
    private final ShopService shop;
    private final AppProperties props;
    private final ObjectMapper mapper;

    public PayNotifyController(ShopService shop, AppProperties props, ObjectMapper mapper) {
        this.shop = shop;
        this.props = props;
        this.mapper = mapper;
    }

    /** POST 回调（JSON / 表单） */
    @PostMapping("/notify/{channel}")
    public String notifyPost(@PathVariable String channel,
                             @RequestBody(required = false) String body,
                             @RequestParam Map<String, String> params,
                             HttpServletRequest req) {
        return shop.handleNotify(channel, body, params, headers(req));
    }

    /** GET 回调（易支付系用这种方式） */
    @GetMapping("/notify/{channel}")
    public String notifyGet(@PathVariable String channel,
                            @RequestParam Map<String, String> params,
                            HttpServletRequest req) {
        return shop.handleNotify(channel, null, params, headers(req));
    }

    // ── mock 收银台（仅开发/联调） ──

    @GetMapping(value = "/mock/checkout", produces = MediaType.TEXT_HTML_VALUE + ";charset=UTF-8")
    public String mockCheckout(@RequestParam String order, @RequestParam String token) {
        ShopOrder o = shop.assertBuyer(order, token);
        long yuan = o.getAmountCents() / 100;
        long cents = o.getAmountCents() % 100;
        return """
                <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
                <title>模拟支付</title>
                <style>
                  body{font-family:system-ui;background:#f5f6f8;display:flex;justify-content:center;padding-top:80px}
                  .card{background:#fff;border:1px solid #e3e8ef;border-radius:10px;padding:28px 36px;min-width:320px;text-align:center}
                  .amt{font-size:34px;font-weight:600;margin:12px 0}
                  button{height:38px;padding:0 22px;border:none;border-radius:6px;background:#2f6fd0;color:#fff;font-size:14px;cursor:pointer}
                  .hint{color:#8a94a6;font-size:12px;margin-top:14px}
                </style></head>
                <body><div class="card">
                  <div>订单号</div><div style="font-family:monospace">%s</div>
                  <div class="amt">¥%d.%02d</div>
                  <button onclick="pay()">模拟支付成功</button>
                  <div class="hint">仅开发环境可见，不会产生真实扣款</div>
                </div>
                <script>
                  async function pay(){
                    const r = await fetch('/v1/pay/mock/pay',{method:'POST',headers:{'Content-Type':'application/json'},
                      body:JSON.stringify({outTradeNo:'%s',token:'%s'})});
                    const j = await r.json().catch(()=>({}));
                    if(r.ok){ document.body.innerHTML='<div style="text-align:center;font-size:20px">支付成功，可关闭本页</div>'; }
                    else{ alert('支付失败: '+(j.message||r.status)); }
                  }
                </script></body></html>
                """.formatted(o.getOutTradeNo(), yuan, cents, o.getOutTradeNo(), token);
    }

    @PostMapping("/mock/pay")
    public Map<String, Object> mockPay(@RequestBody Map<String, String> body) {
        String secret = props.getPayMockSecret();
        if (secret == null || secret.isBlank()) {
            throw new ApiException("CHANNEL_DISABLED", "mock 渠道未启用");
        }
        String no = body.get("outTradeNo");
        String token = body.get("token");
        ShopOrder o = shop.assertBuyer(no, token);

        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("eventId", "mock_" + UUID.randomUUID());
            payload.put("outTradeNo", o.getOutTradeNo());
            payload.put("amountCents", o.getAmountCents());
            payload.put("transactionId", "MOCK" + System.currentTimeMillis());
            String raw = mapper.writeValueAsString(payload);
            String sign = MockPaymentChannel.sign(raw, secret);
            shop.handleNotify("mock", raw, Collections.emptyMap(),
                    Collections.singletonMap(MockPaymentChannel.SIGN_HEADER.toLowerCase(), sign));
            return Map.of("ok", true);
        } catch (Exception e) {
            throw new ApiException("MOCK_PAY_FAILED", e.getMessage());
        }
    }

    private static Map<String, String> headers(HttpServletRequest req) {
        Map<String, String> out = new HashMap<>();
        for (String name : Collections.list(req.getHeaderNames())) {
            out.put(name.toLowerCase(Locale.ROOT), req.getHeader(name));
        }
        return out;
    }
}
