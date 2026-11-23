package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "license_key")
public class LicenseKey {
    public static final String STATUS_UNUSED = "unused";
    public static final String STATUS_ACTIVE = "active";
    public static final String STATUS_REVOKED = "revoked";

    @Id
    @Column(length = 36)
    private String id;

    /** HMAC-SHA256(pepper, normalizedKey)，永不存明文 */
    @Column(name = "key_hash", nullable = false, unique = true, length = 64)
    private String keyHash;

    @Column(name = "plan_id", nullable = false, length = 36)
    private String planId;

    @Column(name = "batch_id", length = 64)
    private String batchId;

    @Column(nullable = false, length = 16)
    private String status;

    /** 生成时可覆盖套餐默认天数；为空用套餐的 */
    @Column(name = "duration_days")
    private Integer durationDays;

    @Column(name = "activated_at")
    private Long activatedAt;

    @Column(name = "expire_at")
    private Long expireAt;

    @Column(length = 255)
    private String note;

    @Column(name = "created_at", nullable = false)
    private long createdAt;
}
