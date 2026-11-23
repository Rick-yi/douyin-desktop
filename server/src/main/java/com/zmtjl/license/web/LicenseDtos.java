package com.zmtjl.license.web;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

import java.util.List;

public final class LicenseDtos {
    private LicenseDtos() {}

    public record ActivateRequest(
            @NotBlank(message = "不能为空") String key,
            @NotBlank(message = "不能为空") String deviceId,
            String appVersion) {}

    public record HeartbeatRequest(
            @NotBlank(message = "不能为空") String token,
            @NotBlank(message = "不能为空") String deviceId,
            String appVersion) {}

    public record DeactivateRequest(
            @NotBlank(message = "不能为空") String token,
            @NotBlank(message = "不能为空") String deviceId) {}

    public record TokenResponse(
            String token,
            long expiresAt,
            String plan,
            List<String> features,
            int deviceLimit,
            long keyExpireAt) {}

    public record OkResponse(boolean ok) {}

    // ── 管理接口 ──

    public record GenerateRequest(
            @NotBlank(message = "不能为空") String plan,
            @Min(value = 1, message = "至少 1 张") @Max(value = 1000, message = "一次最多 1000 张") int count,
            Integer durationDays,
            String batch,
            String note) {}

    public record GeneratedKey(String id, String key) {}

    public record GenerateResponse(String batch, int count, List<GeneratedKey> keys) {}

    public record ExtendRequest(@Min(value = 1, message = "至少 1 天") int days) {}

    public record BatchRequest(@NotBlank(message = "批次不能为空") String batch) {}

    public record BatchExtendRequest(
            @NotBlank(message = "批次不能为空") String batch,
            @Min(value = 1, message = "至少 1 天") int days) {}
}
