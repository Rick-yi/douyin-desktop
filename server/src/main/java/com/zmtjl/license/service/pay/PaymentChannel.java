package com.zmtjl.license.service.pay;

import com.zmtjl.license.domain.Product;
import com.zmtjl.license.domain.ShopOrder;

import java.util.Map;

/**
 * 支付渠道抽象
 *
 * 新增渠道只需要实现这个接口并注册成 Spring Bean，然后在 app.pay.pay-channels 里列出 code。
 * 订单、发卡、幂等这些业务逻辑与渠道无关。
 */
public interface PaymentChannel {

    String code();

    /**
     * 下单：返回收银台地址或二维码内容。
     * 手工渠道返回 null。
     */
    CreatedPayment createPayment(ShopOrder order, Product product);

    /**
     * 验证异步通知。
     * 实现方必须校验签名，并返回可信的订单号/金额/事件 ID。
     * 未知或不支持的渠道抛 ApiException。
     */
    NotifyPayload verifyNotify(String rawBody, Map<String, String> params, Map<String, String> headers);

    /** 通知成功后要回给支付平台的字符串 */
    default String ackBody() {
        return "success";
    }

    record CreatedPayment(String payUrl, String qrCode, String raw) {}

    record NotifyPayload(
            String eventId,
            String outTradeNo,
            long amountCents,
            String transactionId,
            String raw) {}
}
