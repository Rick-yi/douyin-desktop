package com.zmtjl.license.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.domain.Plan;
import com.zmtjl.license.repo.PlanRepository;
import com.zmtjl.license.web.AdminPlanDtos.PlanUpsertRequest;
import com.zmtjl.license.web.AdminPlanDtos.PlanView;
import com.zmtjl.license.web.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

@Service
public class PlanService {
    private final PlanRepository repo;
    private final ObjectMapper mapper;
    private final Clock clock;

    public PlanService(PlanRepository repo, ObjectMapper mapper, Clock clock) {
        this.repo = repo;
        this.mapper = mapper;
        this.clock = clock;
    }

    public List<PlanView> list() {
        return repo.findAllByOrderByCreatedAtAsc().stream().map(this::view).toList();
    }

    @Transactional
    public PlanView create(PlanUpsertRequest req) {
        String code = normalizeCode(req.code());
        if (repo.existsByCode(code)) {
            throw new ApiException("PLAN_CODE_EXISTS", "套餐标识已存在");
        }
        Plan plan = new Plan();
        plan.setId(UUID.randomUUID().toString());
        plan.setCode(code);
        plan.setCreatedAt(clock.millis());
        apply(plan, req);
        return view(repo.save(plan));
    }

    @Transactional
    public PlanView update(String id, PlanUpsertRequest req) {
        Plan plan = repo.findById(id)
                .orElseThrow(() -> new ApiException("PLAN_NOT_FOUND", "套餐不存在", HttpStatus.NOT_FOUND));
        String code = normalizeCode(req.code());
        if (!code.equals(plan.getCode())) {
            // 商品和卡密都按 plan.code 关联，不允许改 code
            throw new ApiException("PLAN_CODE_IMMUTABLE", "套餐标识创建后不能修改");
        }
        apply(plan, req);
        return view(repo.save(plan));
    }

    private void apply(Plan plan, PlanUpsertRequest req) {
        plan.setName(req.name().trim());
        plan.setDeviceLimit(req.deviceLimit());
        plan.setDurationDays(req.durationDays());
        plan.setFeaturesJson(writeFeatures(req.features()));
    }

    private String writeFeatures(List<String> features) {
        Set<String> unique = new LinkedHashSet<>();
        for (String f : features) {
            String v = f == null ? "" : f.trim();
            if (!v.isEmpty()) unique.add(v);
        }
        if (unique.isEmpty()) {
            throw new ApiException("FEATURES_EMPTY", "至少配置一个功能");
        }
        try {
            return mapper.writeValueAsString(new ArrayList<>(unique));
        } catch (Exception e) {
            throw new ApiException("FEATURES_INVALID", "功能列表格式错误");
        }
    }

    private PlanView view(Plan plan) {
        List<String> features = new ArrayList<>();
        try {
            features = mapper.readValue(plan.getFeaturesJson(), new TypeReference<List<String>>() {});
        } catch (Exception ignored) {}
        return new PlanView(
                plan.getId(),
                plan.getCode(),
                plan.getName(),
                features,
                plan.getDeviceLimit(),
                plan.getDurationDays(),
                plan.getCreatedAt());
    }

    private static String normalizeCode(String raw) {
        return raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
    }
}
