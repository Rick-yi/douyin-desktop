package com.zmtjl.license.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/** 单次跳转点击明细（用于后台查看来源和统计） */
@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "jump_click")
public class JumpClick {
    @Id
    @Column(length = 36)
    private String id;

    @Column(name = "card_id", nullable = false, length = 36)
    private String cardId;

    @Column(nullable = false, length = 16)
    private String code;

    @Column(length = 64)
    private String ip;

    @Column(name = "user_agent", length = 512)
    private String userAgent;

    @Column(length = 1024)
    private String referer;

    @Column(name = "clicked_at", nullable = false)
    private long clickedAt;
}
