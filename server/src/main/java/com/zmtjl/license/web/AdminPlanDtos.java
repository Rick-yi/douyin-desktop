package com.zmtjl.license.web;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;

public final class AdminPlanDtos {
    private AdminPlanDtos() {}

    public record PlanView(
            String id,
            String code,
            String name,
            List<String> features,
            int deviceLimit,
            int durationDays,
            long createdAt) {}

    public record PlanUpsertRequest(
            @NotBlank(message = "不能为空")
            @Pattern(regexp = "[a-z0-9_-]{2,32}", message = "只能包含小写字母、数字、_、-，长度 2-32")
            String code,
            @NotBlank(message = "不能为空")
            @Size(max = 64, message = "最多 64 个字符")
            String name,
            @NotEmpty(message = "至少一个功能")
            @Size(max = 50, message = "最多 50 个功能")
            List<@NotBlank @Size(max = 32) String> features,
            @Min(value = 1, message = "至少 1 台设备")
            @Max(value = 100, message = "最多 100 台设备")
            int deviceLimit,
            @Min(value = 1, message = "至少 1 天")
            @Max(value = 3650, message = "最多 3650 天")
            int durationDays) {}
}
