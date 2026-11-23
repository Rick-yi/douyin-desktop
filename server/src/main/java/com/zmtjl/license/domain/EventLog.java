package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "event_log")
public class EventLog {
    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false, length = 32)
    private String type;

    @Column(name = "key_id", length = 36)
    private String keyId;

    @Column(name = "device_id_hash", length = 64)
    private String deviceIdHash;

    @Column(name = "meta_json", columnDefinition = "TEXT")
    private String metaJson;

    @Column(name = "created_at", nullable = false)
    private long createdAt;
}
