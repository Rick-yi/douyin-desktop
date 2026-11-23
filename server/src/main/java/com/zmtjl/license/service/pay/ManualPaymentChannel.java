package com.zmtjl.license.service.pay;

import com.zmtjl.license.domain.Product;
import com.zmtjl.license.domain.ShopOrder;
import com.zmtjl.license.web.ApiException;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 手工渠道：线下收款（淘宝/微信/闲鱼），管理员在后台标记已支付后发卡。
 * 没有异步回调。
 */
@Component
public class ManualPaymentChannel implements PaymentChannel {

    @Override
    public String code() {
        return "manual";
    }

    @Override
    public CreatedPayment createPayment(ShopOrder order, Product product) {
        return new CreatedPayment(null, null, null);
    }

    @Override
    public NotifyPayload verifyNotify(String rawBody, Map<String, String> params, Map<String, String> headers) {
        throw new ApiException("NOTIFY_UNSUPPORTED", "手工渠道不支持支付回调");
    }
}
