package com.zmtjl.license.service.pay;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.domain.Product;
import com.zmtjl.license.domain.ShopOrder;
import com.zmtjl.license.web.ApiException;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;

/**
 * 模拟支付渠道（仅开发/联调用）
 *
 * 走完整的「签名 → 回调 → 验签 → 发卡」链路，方便在没有真实支付账号时把流程跑通。
 * 生产环境不要把它列进 app.pay.pay-channels。
 */
@Component
public class MockPaymentChannel implements PaymentChannel {
    public static final String SIGN_HEADER = "X-Mock-Signature";

    private final ObjectMapper mapper;
    private final AppProperties props;

    public MockPaymentChannel(ObjectMapper mapper, AppProperties props) {
        this.mapper = mapper;
        this.props = props;
    }

    @Override
    public String code() {
        return "mock";
    }

    @Override
    public CreatedPayment createPayment(ShopOrder order, Product product) {
        String base = props.getPublicBaseUrl().replaceAll("/+$", "");
        String url = base + "/v1/pay/mock/checkout?order=" + order.getOutTradeNo()
                + "&token=" + order.getDeliveryToken();
        return new CreatedPayment(url, null, null);
    }

    @Override
    public NotifyPayload verifyNotify(String rawBody, Map<String, String> params, Map<String, String> headers) {
        String secret = props.getPayMockSecret();
        if (secret == null || secret.isBlank()) {
            throw new ApiException("CHANNEL_DISABLED", "mock 渠道未启用");
        }
        String given = headers.getOrDefault(SIGN_HEADER.toLowerCase(), "");
        String expected = sign(rawBody, secret);
        if (given == null || !MessageDigest.isEqual(
                given.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8))) {
            throw new ApiException("SIGN_INVALID", "回调签名无效");
        }
        try {
            Map<?, ?> body = mapper.readValue(rawBody, Map.class);
            return new NotifyPayload(
                    String.valueOf(body.get("eventId")),
                    String.valueOf(body.get("outTradeNo")),
                    ((Number) body.get("amountCents")).longValue(),
                    body.get("transactionId") == null ? null : String.valueOf(body.get("transactionId")),
                    rawBody);
        } catch (Exception e) {
            throw new ApiException("NOTIFY_INVALID", "回调内容无法解析");
        }
    }

    public static String sign(String rawBody, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(
                    (rawBody == null ? "" : rawBody).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("HMAC 初始化失败", e);
        }
    }
}
