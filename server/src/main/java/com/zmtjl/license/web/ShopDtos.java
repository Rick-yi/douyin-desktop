package com.zmtjl.license.web;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public final class ShopDtos {
    private ShopDtos() {}

    public record ProductView(
            String id,
            String code,
            String name,
            String planCode,
            long priceCents,
            Integer durationDays,
            int deviceLimit,
            String status) {}

    public record ChannelView(String code) {}

    public record CreateOrderRequest(
            @NotBlank(message = "不能为空") String productId,
            @NotBlank(message = "不能为空") String channel,
            String note) {}

    public record OrderCreated(
            String outTradeNo,
            long amountCents,
            String channel,
            String status,
            String payUrl,
            String qrCode,
            String token,
            long expiresAt) {}

    public record BuyerOrderView(
            String outTradeNo,
            String status,
            long amountCents,
            String channel,
            String productName,
            String planCode,
            Integer durationDays,
            String key,
            Long paidAt,
            long expiresAt,
            long createdAt) {}

    public record AdminOrderView(
            String outTradeNo,
            String productName,
            String planCode,
            long amountCents,
            String channel,
            String status,
            String transactionId,
            String keyId,
            String keyMasked,
            String buyerNote,
            Long paidAt,
            Long deliveredAt,
            long expiresAt,
            long createdAt) {}

    public record ProductUpsertRequest(
            @NotBlank(message = "不能为空") String code,
            @NotBlank(message = "不能为空") String name,
            @NotBlank(message = "不能为空") String planCode,
            @NotNull(message = "不能为空") @Min(value = 1, message = "价格必须大于 0") Long priceCents,
            Integer durationDays,
            String status) {}

    public record RefundResult(String outTradeNo, String status, boolean keyRevoked, String message) {}

    public record MarkPaidRequest(String transactionId) {}
}
