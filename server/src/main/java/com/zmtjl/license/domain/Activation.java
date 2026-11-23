package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "activation",
        uniqueConstraints = @UniqueConstraint(name = "uq_activation_key_device",
                columnNames = {"key_id", "device_id_hash"}))
public class Activation {
    @Id
    @Column(length = 36)
    private String id;

    @Column(name = "key_id", nullable = false, length = 36)
    private String keyId;

    @Column(name = "device_id_hash", nullable = false, length = 64)
    private String deviceIdHash;

    @Column(name = "app_version", length = 32)
    private String appVersion;

    @Column(name = "activated_at", nullable = false)
    private long activatedAt;

    @Column(name = "last_seen_at")
    private Long lastSeenAt;

    @Column(name = "revoked_at")
    private Long revokedAt;

    @Column(name = "last_ip", length = 64)
    private String lastIp;

    public boolean isActive() {
        return revokedAt == null;
    }
}
