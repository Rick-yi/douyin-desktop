package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * 跳转卡：后台配置一张卡片，对外暴露稳定短链 /r/{code}
 *
 * target_url 可以随时修改，已经发到抖音私信里的短链不变。
 */
@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "jump_card")
public class JumpCard {
    public static final String STATUS_ACTIVE = "active";
    public static final String STATUS_DISABLED = "disabled";
    public static final String TARGET_URL = "url";
    public static final String TARGET_WECHAT_QR = "wechat_qr";
    public static final String TARGET_WECOM = "wecom";

    @Id
    @Column(length = 36)
    private String id;

    /** 短链标识，大写字母/数字/下划线/中划线 */
    @Column(nullable = false, unique = true, length = 16)
    private String code;

    @Column(nullable = false, length = 128)
    private String name;

    /** url：直接 302；wechat_qr：个人微信二维码；wecom：企业微信联系我 */
    @Column(name = "target_type", nullable = false, length = 32)
    private String targetType = TARGET_URL;

    @Column(name = "target_url", nullable = false, length = 1024)
    private String targetUrl;

    @Column(name = "qr_image_url", length = 1024)
    private String qrImageUrl;

    @Column(length = 128)
    private String title;

    @Column(length = 255)
    private String description;

    @Column(name = "cover_url", length = 1024)
    private String coverUrl;

    @Column(name = "group_name", length = 64)
    private String groupName;

    @Column(nullable = false, length = 16)
    private String status;

    @Column(name = "click_count", nullable = false)
    private long clickCount;

    @Column(name = "last_click_at")
    private Long lastClickAt;

    @Column(name = "created_at", nullable = false)
    private long createdAt;

    @Column(name = "updated_at", nullable = false)
    private long updatedAt;

    public boolean isActive() {
        return STATUS_ACTIVE.equals(status);
    }
}
