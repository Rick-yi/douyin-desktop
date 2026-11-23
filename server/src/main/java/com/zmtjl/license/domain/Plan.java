package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "plan")
public class Plan {
    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false, unique = true, length = 32)
    private String code;

    @Column(nullable = false, length = 64)
    private String name;

    /** JSON 数组字符串，如 ["chat","broadcast"] */
    @Column(name = "features_json", nullable = false, columnDefinition = "TEXT")
    private String featuresJson;

    @Column(name = "device_limit", nullable = false)
    private int deviceLimit;

    @Column(name = "duration_days", nullable = false)
    private int durationDays;

    @Column(name = "created_at", nullable = false)
    private long createdAt;
}
