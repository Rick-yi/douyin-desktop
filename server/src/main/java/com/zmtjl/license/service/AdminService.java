package com.zmtjl.license.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.crypto.KeyCodec;
import com.zmtjl.license.domain.Activation;
import com.zmtjl.license.domain.EventLog;
import com.zmtjl.license.domain.LicenseKey;
import com.zmtjl.license.domain.Plan;
import com.zmtjl.license.repo.ActivationRepository;
import com.zmtjl.license.repo.EventLogRepository;
import com.zmtjl.license.repo.LicenseKeyRepository;
import com.zmtjl.license.repo.PlanRepository;
import com.zmtjl.license.web.ApiException;
import com.zmtjl.license.web.LicenseDtos.GenerateResponse;
import com.zmtjl.license.web.LicenseDtos.GeneratedKey;
import com.zmtjl.license.web.PageResponse;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 管理侧：批量生成、查询、作废、延期、解绑
 *
 * 生成接口是唯一会返回卡密明文的地方，调用方必须一次性保存。
 */
@Service
public class AdminService {
    private static final long DAY_MS = 86_400_000L;

    private final LicenseKeyRepository keyRepo;
    private final PlanRepository planRepo;
    private final ActivationRepository activationRepo;
    private final EventLogRepository eventRepo;
    private final KeyCodec keyCodec;
    private final Clock clock;
    private final ObjectMapper mapper;

    public AdminService(LicenseKeyRepository keyRepo,
                        PlanRepository planRepo,
                        ActivationRepository activationRepo,
                        EventLogRepository eventRepo,
                        KeyCodec keyCodec,
                        Clock clock,
                        ObjectMapper mapper) {
        this.keyRepo = keyRepo;
        this.planRepo = planRepo;
        this.activationRepo = activationRepo;
        this.eventRepo = eventRepo;
        this.keyCodec = keyCodec;
        this.clock = clock;
        this.mapper = mapper;
    }

    @Transactional
    public GenerateResponse generate(String planCode, int count, Integer durationDays,
                                     String batch, String note) {
        Plan plan = planRepo.findByCode(planCode)
                .orElseThrow(() -> new ApiException("PLAN_NOT_FOUND", "套餐不存在: " + planCode));
        String batchId = (batch == null || batch.isBlank())
                ? "B" + clock.millis() : batch.trim();
        long now = clock.millis();

        List<GeneratedKey> out = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            NewKey nk = newKey(plan, batchId, durationDays, note, now);
            keyRepo.save(nk.entity());
            out.add(new GeneratedKey(nk.entity().getId(), keyCodec.format(nk.payload())));
        }
        return new GenerateResponse(batchId, count, out);
    }

    private record NewKey(LicenseKey entity, String payload) {}

    private NewKey newKey(Plan plan, String batchId, Integer durationDays, String note, long now) {
        for (int attempt = 0; attempt < 5; attempt++) {
            String payload = keyCodec.generatePayload();
            String hash = keyCodec.hash(payload);
            if (keyRepo.findByKeyHash(hash).isPresent()) continue;

            LicenseKey key = new LicenseKey();
            key.setId(UUID.randomUUID().toString());
            key.setKeyHash(hash);
            key.setPlanId(plan.getId());
            key.setBatchId(batchId);
            key.setStatus(LicenseKey.STATUS_UNUSED);
            key.setDurationDays(durationDays);
            key.setNote(note == null ? null : note.substring(0, Math.min(255, note.length())));
            key.setCreatedAt(now);
            // 明文只通过返回值给调用方，绝不写库
            return new NewKey(key, payload);
        }
        throw new ApiException("KEY_GENERATE_FAILED", "卡密生成失败，请重试");
    }

    public Object list(String batchId, Integer page, Integer size) {
        if (page == null) {
            List<LicenseKey> keys = (batchId == null || batchId.isBlank())
                    ? keyRepo.findTop200ByOrderByCreatedAtDesc()
                    : keyRepo.findByBatchIdOrderByCreatedAtAsc(batchId);
            List<Map<String, Object>> out = new ArrayList<>(keys.size());
            for (LicenseKey k : keys) out.add(brief(k));
            return out;
        }
        int p = Math.max(0, page);
        int s = Math.max(1, Math.min(200, size == null ? 50 : size));
        PageRequest pr = PageRequest.of(p, s);
        Page<LicenseKey> result = (batchId == null || batchId.isBlank())
                ? keyRepo.findAllByOrderByCreatedAtDesc(pr)
                : keyRepo.findByBatchIdOrderByCreatedAtAsc(batchId, pr);
        return PageResponse.of(result, this::brief);
    }

    /** 单张发卡（订单支付成功后调用） */
    @Transactional
    public GeneratedKey issueKey(String planCode, Integer durationDays, String note) {
        Plan plan = planRepo.findByCode(planCode)
                .orElseThrow(() -> new ApiException("PLAN_NOT_FOUND", "套餐不存在: " + planCode));
        NewKey nk = newKey(plan, null, durationDays, note, clock.millis());
        keyRepo.save(nk.entity());
        return new GeneratedKey(nk.entity().getId(), keyCodec.format(nk.payload()));
    }

    @Transactional
    public Map<String, Object> revoke(String keyId) {
        LicenseKey key = mustGet(keyId);
        key.setStatus(LicenseKey.STATUS_REVOKED);
        keyRepo.save(key);
        logEvent("admin_revoke", keyId, null, Map.of());
        return brief(key);
    }

    @Transactional
    public Map<String, Object> extend(String keyId, int days) {
        LicenseKey key = mustGet(keyId);
        extendKey(key, days);
        keyRepo.save(key);
        logEvent("admin_extend", keyId, null, Map.of("days", days));
        return brief(key);
    }

    @Transactional
    public Map<String, Object> batchRevoke(String batchId) {
        List<LicenseKey> keys = batchKeys(batchId);
        for (LicenseKey key : keys) {
            key.setStatus(LicenseKey.STATUS_REVOKED);
        }
        keyRepo.saveAll(keys);
        logEvent("admin_batch_revoke", null, null,
                Map.of("batch", batchId.trim(), "count", keys.size()));
        return Map.of("ok", true, "batch", batchId.trim(), "count", keys.size());
    }

    @Transactional
    public Map<String, Object> batchExtend(String batchId, int days) {
        List<LicenseKey> keys = batchKeys(batchId);
        for (LicenseKey key : keys) {
            extendKey(key, days);
        }
        keyRepo.saveAll(keys);
        logEvent("admin_batch_extend", null, null,
                Map.of("batch", batchId.trim(), "count", keys.size(), "days", days));
        return Map.of("ok", true, "batch", batchId.trim(), "count", keys.size(), "days", days);
    }

    /** 批次导出：只导出元数据，不包含卡密明文（库里没有明文） */
    public List<Map<String, Object>> exportRows(String batchId) {
        List<LicenseKey> keys = batchKeys(batchId);
        List<Map<String, Object>> out = new ArrayList<>(keys.size());
        for (LicenseKey key : keys) out.add(brief(key));
        return out;
    }

    private List<LicenseKey> batchKeys(String batchId) {
        if (batchId == null || batchId.isBlank()) {
            throw new ApiException("BATCH_REQUIRED", "请指定批次");
        }
        List<LicenseKey> keys = keyRepo.findByBatchIdOrderByCreatedAtAsc(batchId.trim());
        if (keys.isEmpty()) {
            throw new ApiException("BATCH_NOT_FOUND", "批次不存在或没有卡密", HttpStatus.NOT_FOUND);
        }
        return keys;
    }

    private void extendKey(LicenseKey key, int days) {
        if (key.getExpireAt() == null) {
            // 未激活：延长的是「激活后的有效天数」
            int base = key.getDurationDays() != null ? key.getDurationDays()
                    : planDays(key.getPlanId());
            key.setDurationDays(base + days);
        } else {
            long base = Math.max(key.getExpireAt(), clock.millis());
            key.setExpireAt(base + days * DAY_MS);
        }
    }

    @Transactional
    public Map<String, Object> unbind(String activationId) {
        Activation a = activationRepo.findById(activationId)
                .orElseThrow(() -> new ApiException("ACTIVATION_NOT_FOUND", "激活记录不存在"));
        if (a.isActive()) {
            a.setRevokedAt(clock.millis());
            activationRepo.save(a);
            logEvent("admin_unbind", a.getKeyId(), a.getDeviceIdHash(), Map.of());
        }
        return Map.of("ok", true, "activationId", activationId);
    }

    public Map<String, Object> lookup(String rawKey) {
        String normalized = keyCodec.normalize(rawKey);
        LicenseKey key = keyRepo.findByKeyHash(keyCodec.hash(normalized))
                .orElseThrow(() -> new ApiException("KEY_NOT_FOUND", "卡密不存在",
                        HttpStatus.NOT_FOUND));
        return detail(key);
    }

    /** 按 keyId 查详情（管理页面列表用） */
    public Map<String, Object> lookupById(String id) {
        return detail(mustGet(id));
    }

    private Map<String, Object> detail(LicenseKey key) {
        Map<String, Object> m = brief(key);
        List<Map<String, Object>> acts = new ArrayList<>();
        for (Activation a : activationRepo.findByKeyIdOrderByActivatedAtAsc(key.getId())) {
            Map<String, Object> am = new LinkedHashMap<>();
            am.put("id", a.getId());
            am.put("device", maskHash(a.getDeviceIdHash()));
            am.put("appVersion", a.getAppVersion());
            am.put("activatedAt", a.getActivatedAt());
            am.put("lastSeenAt", a.getLastSeenAt());
            am.put("revokedAt", a.getRevokedAt());
            am.put("active", a.isActive());
            acts.add(am);
        }
        m.put("activations", acts);
        return m;
    }

    public Object events(Integer page, Integer size) {
        if (page == null) return eventRepo.findTop100ByOrderByCreatedAtDesc();
        int p = Math.max(0, page);
        int s = Math.max(1, Math.min(200, size == null ? 50 : size));
        return PageResponse.of(eventRepo.findAllByOrderByCreatedAtDesc(PageRequest.of(p, s)), e -> e);
    }

    // ── 内部 ──

    private LicenseKey mustGet(String id) {
        return keyRepo.findById(id)
                .orElseThrow(() -> new ApiException("KEY_NOT_FOUND", "卡密不存在",
                        HttpStatus.NOT_FOUND));
    }

    private int planDays(String planId) {
        return planRepo.findById(planId).map(Plan::getDurationDays).orElse(0);
    }

    private Map<String, Object> brief(LicenseKey k) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", k.getId());
        m.put("batch", k.getBatchId());
        m.put("status", k.getStatus());
        m.put("planId", k.getPlanId());
        m.put("durationDays", k.getDurationDays());
        m.put("activatedAt", k.getActivatedAt());
        m.put("expireAt", k.getExpireAt());
        m.put("createdAt", k.getCreatedAt());
        m.put("deviceLimit", planDeviceLimit(k.getPlanId()));
        m.put("activeDevices", activationRepo.countByKeyIdAndRevokedAtIsNull(k.getId()));
        // 不返回完整哈希，避免日志里被撞库比对
        m.put("keyHashPrefix", maskHash(k.getKeyHash()));
        return m;
    }

    private int planDeviceLimit(String planId) {
        return planRepo.findById(planId).map(Plan::getDeviceLimit).orElse(0);
    }

    private static String maskHash(String h) {
        if (h == null) return "";
        return h.substring(0, Math.min(8, h.length())) + "…";
    }

    private void logEvent(String type, String keyId, String deviceHash, Map<String, Object> meta) {
        try {
            EventLog e = new EventLog();
            e.setId(UUID.randomUUID().toString());
            e.setType(type);
            e.setKeyId(keyId);
            e.setDeviceIdHash(deviceHash);
            e.setMetaJson(meta.isEmpty() ? "{}" : mapper.writeValueAsString(meta));
            e.setCreatedAt(clock.millis());
            eventRepo.save(e);
        } catch (Exception ignored) {
        }
    }
}
