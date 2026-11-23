package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "app_release")
public class AppRelease {
    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false, length = 16)
    private String platform;

    @Column(nullable = false, length = 16)
    private String channel;

    @Column(nullable = false, length = 32)
    private String version;

    @Column(name = "min_version", length = 32)
    private String minVersion;

    @Column(name = "force_update", nullable = false)
    private boolean forceUpdate;

    @Column(columnDefinition = "TEXT")
    private String notes;

    @Column(name = "file_name", nullable = false, length = 255)
    private String fileName;

    @Column(name = "stored_name", nullable = false, length = 255)
    private String storedName;

    @Column(name = "file_size", nullable = false)
    private long fileSize;

    @Column(nullable = false, length = 64)
    private String sha256;

    @Column(nullable = false)
    private boolean active;

    @Column(name = "created_at", nullable = false)
    private long createdAt;

    @Column(name = "published_at")
    private Long publishedAt;
}
