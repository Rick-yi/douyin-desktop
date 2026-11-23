package com.zmtjl.license.web;

import jakarta.validation.constraints.NotBlank;

import java.util.List;

public final class JumpCardDtos {
    private JumpCardDtos() {}

    /** 管理端完整视图 */
    public record JumpCardView(
            String id,
            String code,
            String name,
            String targetType,
            String targetUrl,
            String qrImageUrl,
            String title,
            String description,
            String coverUrl,
            String groupName,
            String status,
            long clickCount,
            Long lastClickAt,
            String shortUrl,
            long createdAt,
            long updatedAt) {}

    /** 客户端可拉取的公开视图（只暴露短链，不暴露真实目标地址） */
    public record PublicJumpCardView(
            String code,
            String name,
            String targetType,
            String title,
            String description,
            String coverUrl,
            String groupName,
            String shortUrl) {}

    public record JumpCardUpsertRequest(
            /** 可选：自定义短链标识；留空自动生成 */
            String code,
            @NotBlank(message = "不能为空") String name,
            /** url | wechat_qr，默认 url */
            String targetType,
            /** targetType=url 时必填 */
            String targetUrl,
            /** targetType=wechat_qr 时必填，公网二维码图片地址 */
            String qrImageUrl,
            String title,
            String description,
            String coverUrl,
            String groupName,
            /** active | disabled，默认 active */
            String status) {}

    public record JumpClickView(
            String id,
            String ip,
            String userAgent,
            String referer,
            long clickedAt) {}

    public record JumpCardDetail(
            JumpCardView card,
            long totalClicks,
            List<JumpClickView> recentClicks) {}
}
