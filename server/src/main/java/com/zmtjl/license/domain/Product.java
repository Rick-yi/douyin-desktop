package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "product")
public class Product {
    public static final String STATUS_ACTIVE = "active";
    public static final String STATUS_DISABLED = "disabled";

    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false, unique = true, length = 64)
    private String code;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(name = "plan_code", nullable = false, length = 32)
    private String planCode;

    /** 单位：分 */
    @Column(name = "price_cents", nullable = false)
    private long priceCents;

    /** 空表示用套餐默认天数 */
    @Column(name = "duration_days")
    private Integer durationDays;

    @Column(nullable = false, length = 16)
    private String status;

    @Column(name = "created_at", nullable = false)
    private long createdAt;
}
