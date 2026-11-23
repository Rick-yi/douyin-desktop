package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "device")
public class Device {
    @Id
    @Column(length = 36)
    private String id;

    @Column(name = "device_id_hash", nullable = false, unique = true, length = 64)
    private String deviceIdHash;

    @Column(name = "first_seen_at", nullable = false)
    private long firstSeenAt;

    @Column(name = "last_seen_at")
    private Long lastSeenAt;

    @Column(length = 255)
    private String note;
}
