package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/** 支付回调事件：channel + event_id 唯一，用于幂等 */
@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "payment_event",
        uniqueConstraints = @UniqueConstraint(name = "uq_payment_event",
                columnNames = {"channel", "event_id"}))
public class PaymentEvent {
    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false, length = 32)
    private String channel;

    @Column(name = "event_id", nullable = false, length = 128)
    private String eventId;

    @Column(name = "out_trade_no", length = 40)
    private String outTradeNo;

    @Column(name = "amount_cents")
    private Long amountCents;

    @Column(columnDefinition = "TEXT")
    private String raw;

    @Column(name = "created_at", nullable = false)
    private long createdAt;
}
