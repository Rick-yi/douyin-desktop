package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "shop_order")
public class ShopOrder {
    public static final String STATUS_CREATED = "created";
    public static final String STATUS_PAID = "paid";
    public static final String STATUS_REFUNDED = "refunded";
    public static final String STATUS_CANCELLED = "cancelled";
    public static final String STATUS_CLOSED = "closed";

    @Id
    @Column(length = 36)
    private String id;

    @Column(name = "out_trade_no", nullable = false, unique = true, length = 40)
    private String outTradeNo;

    @Column(name = "product_id", nullable = false, length = 36)
    private String productId;

    @Column(name = "amount_cents", nullable = false)
    private long amountCents;

    @Column(nullable = false, length = 32)
    private String channel;

    @Column(nullable = false, length = 16)
    private String status;

    @Column(name = "delivery_token", nullable = false, length = 64)
    private String deliveryToken;

    @Column(name = "transaction_id", length = 64)
    private String transactionId;

    @Column(name = "key_id", length = 36)
    private String keyId;

    /** AES-GCM 加密后的卡密明文 */
    @Column(name = "key_cipher", columnDefinition = "TEXT")
    private String keyCipher;

    @Column(name = "buyer_note", length = 255)
    private String buyerNote;

    @Column(name = "expires_at", nullable = false)
    private long expiresAt;

    @Column(name = "paid_at")
    private Long paidAt;

    @Column(name = "delivered_at")
    private Long deliveredAt;

    @Column(name = "closed_at")
    private Long closedAt;

    @Column(name = "created_at", nullable = false)
    private long createdAt;

    public boolean isPaid() {
        return STATUS_PAID.equals(status);
    }
}
