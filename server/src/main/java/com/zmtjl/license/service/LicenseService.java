package com.zmtjl.license.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.crypto.KeyCodec;
import com.zmtjl.license.crypto.TokenService;
import com.zmtjl.license.domain.Activation;
import com.zmtjl.license.domain.Device;
import com.zmtjl.license.domain.EventLog;
import com.zmtjl.license.domain.LicenseKey;
import com.zmtjl.license.domain.Plan;
import com.zmtjl.license.repo.ActivationRepository;
import com.zmtjl.license.repo.DeviceRepository;
import com.zmtjl.license.repo.EventLogRepository;
import com.zmtjl.license.repo.LicenseKeyRepository;
import com.zmtjl.license.repo.PlanRepository;
import com.zmtjl.license.web.ApiException;
import com.zmtjl.license.web.LicenseDtos.TokenResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * 卡密核心流程：激活、心跳、解绑
 */
@Service
public class LicenseService {
    private static final Logger log = LoggerFactory.getLogger(LicenseService.class);
    private static final long DAY_MS = 86_400_000L;

    private final LicenseKeyRepository keyRepo;
    private final PlanRepository planRepo;
    private final ActivationRepository activationRepo;
    private final DeviceRepository deviceRepo;
    private final EventLogRepository eventRepo;
    private final KeyCodec keyCodec;
    private final TokenService tokenService;
    private final AppProperties props;
    private final ObjectMapper mapper;
    private final Clock clock;

    public LicenseService(LicenseKeyRepository keyRepo,
                          PlanRepository planRepo,
                          ActivationRepository activationRepo,
                          DeviceRepository deviceRepo,
                          EventLogRepository eventRepo,
                          KeyCodec keyCodec,
                          TokenService tokenService,
                          AppProperties props,
                          ObjectMapper mapper,
                          Clock clock) {
        this.keyRepo = keyRepo;
        this.planRepo = planRepo;
        this.activationRepo = activationRepo;
        this.deviceRepo = deviceRepo;
        this.eventRepo = eventRepo;
        this.keyCodec = keyCodec;
        this.tokenService = tokenService;
        this.props = props;
        this.mapper = mapper;
        this.clock = clock;
    }

    @Transactional
    public TokenResponse activate(String rawKey, String deviceId, String appVersion, String ip) {
        long now = clock.millis();
        String normalized = keyCodec.normalize(rawKey);
        if (!keyCodec.isValid(normalized)) {
            throw new ApiException("KEY_NOT_FOUND", "卡密不存在或格式不正确");
        }
        LicenseKey key = keyRepo.findByKeyHash(keyCodec.hash(normalized))
                .orElseThrow(() -> new ApiException("KEY_NOT_FOUND", "卡密不存在"));
        Plan plan = planRepo.findById(key.getPlanId())
                .orElseThrow(() -> new ApiException("PLAN_MISSING", "套餐配置缺失"));

        assertUsable(key, now);

        String deviceHash = keyCodec.deviceHash(deviceId);
        Optional<Activation> existing = activationRepo.findByKeyIdAndDeviceIdHash(key.getId(), deviceHash);

        if (existing.isPresent() && existing.get().isActive()) {
            Activation a = existing.get();
            a.setLastSeenAt(now);
            a.setAppVersion(trimVersion(appVersion));
            a.setLastIp(ip);
            activationRepo.save(a);
        } else {
            long activeCount = activationRepo.countByKeyIdAndRevokedAtIsNull(key.getId());
            if (activeCount >= plan.getDeviceLimit()) {
                logEvent("activate_denied", key.getId(), deviceHash, Map.of("reason", "device_limit"));
                throw new ApiException("DEVICE_LIMIT_REACHED",
                        "该卡密已绑定 " + activeCount + " 台设备（上限 " + plan.getDeviceLimit() + "），请联系客服解绑",
                        HttpStatus.CONFLICT);
            }
            Activation a = existing.orElseGet(Activation::new);
            if (a.getId() == null) a.setId(UUID.randomUUID().toString());
            a.setKeyId(key.getId());
            a.setDeviceIdHash(deviceHash);
            a.setActivatedAt(now);
            a.setLastSeenAt(now);
            a.setAppVersion(trimVersion(appVersion));
            a.setLastIp(ip);
            a.setRevokedAt(null);
            activationRepo.save(a);
        }

        if (LicenseKey.STATUS_UNUSED.equals(key.getStatus())) {
            key.setStatus(LicenseKey.STATUS_ACTIVE);
            key.setActivatedAt(now);
            int days = key.getDurationDays() != null ? key.getDurationDays() : plan.getDurationDays();
            key.setExpireAt(now + days * DAY_MS);
            keyRepo.save(key);
        }

        upsertDevice(deviceHash, now);
        logEvent("activate", key.getId(), deviceHash, Map.of("plan", plan.getCode(), "version", safe(appVersion)));
        return issueToken(key, plan, deviceHash, now);
    }

    /**
     * 心跳续签
     *
     * ★ 允许使用已过期的 token 来换新 token（签名有效即可）。
     *   否则用户离线超过 7 天就再也无法续签，只能重新输入卡密。
     */
    @Transactional
    public TokenResponse heartbeat(String token, String deviceId, String appVersion) {
        long now = clock.millis();
        Map<String, Object> claims = tokenService.verify(token);
        String keyId = String.valueOf(claims.get("keyId"));
        String tokenDevice = String.valueOf(claims.get("device"));
        String deviceHash = keyCodec.deviceHash(deviceId);

        if (!tokenDevice.equals(deviceHash)) {
            throw new ApiException("DEVICE_MISMATCH", "授权令牌与本机不匹配", HttpStatus.FORBIDDEN);
        }

        LicenseKey key = keyRepo.findById(keyId)
                .orElseThrow(() -> new ApiException("KEY_NOT_FOUND", "卡密不存在"));
        Plan plan = planRepo.findById(key.getPlanId())
                .orElseThrow(() -> new ApiException("PLAN_MISSING", "套餐配置缺失"));
        assertUsable(key, now);

        Activation activation = activationRepo.findByKeyIdAndDeviceIdHash(keyId, deviceHash)
                .orElseThrow(() -> new ApiException("DEVICE_MISMATCH", "本机未激活", HttpStatus.FORBIDDEN));
        if (!activation.isActive()) {
            throw new ApiException("DEVICE_REVOKED", "本机授权已被解绑", HttpStatus.FORBIDDEN);
        }

        activation.setLastSeenAt(now);
        activation.setAppVersion(trimVersion(appVersion));
        activationRepo.save(activation);
        upsertDevice(deviceHash, now);

        return issueToken(key, plan, deviceHash, now);
    }

    @Transactional
    public void deactivate(String token, String deviceId) {
        long now = clock.millis();
        Map<String, Object> claims = tokenService.verify(token);
        String keyId = String.valueOf(claims.get("keyId"));
        String deviceHash = keyCodec.deviceHash(deviceId);
        if (!String.valueOf(claims.get("device")).equals(deviceHash)) {
            throw new ApiException("DEVICE_MISMATCH", "授权令牌与本机不匹配", HttpStatus.FORBIDDEN);
        }
        Activation activation = activationRepo.findByKeyIdAndDeviceIdHash(keyId, deviceHash)
                .orElseThrow(() -> new ApiException("DEVICE_MISMATCH", "本机未激活", HttpStatus.FORBIDDEN));
        activation.setRevokedAt(now);
        activationRepo.save(activation);
        logEvent("deactivate", keyId, deviceHash, Map.of());
    }

    public String publicKeyPem() {
        return tokenService.publicKeyPem();
    }

    // ── 内部 ──

    private void assertUsable(LicenseKey key, long now) {
        if (LicenseKey.STATUS_REVOKED.equals(key.getStatus())) {
            throw new ApiException("KEY_REVOKED", "卡密已被作废", HttpStatus.FORBIDDEN);
        }
        if (key.getExpireAt() != null && key.getExpireAt() < now) {
            throw new ApiException("KEY_EXPIRED", "卡密已过期", HttpStatus.FORBIDDEN);
        }
    }

    private TokenResponse issueToken(LicenseKey key, Plan plan, String deviceHash, long now) {
        List<String> features = parseFeatures(plan.getFeaturesJson());
        long keyExpireAt = key.getExpireAt() == null ? 0L : key.getExpireAt();
        Map<String, Object> claims = tokenService.baseClaims(
                key.getId(), plan.getCode(), features, deviceHash, now,
                props.getTokenTtlHours(), keyExpireAt);
        var issued = tokenService.issue(claims);
        return new TokenResponse(issued.token(), issued.expiresAt(), plan.getCode(),
                features, plan.getDeviceLimit(), keyExpireAt);
    }

    private List<String> parseFeatures(String json) {
        try {
            return mapper.readValue(json, new TypeReference<List<String>>() {});
        } catch (Exception e) {
            return List.of();
        }
    }

    private void upsertDevice(String deviceHash, long now) {
        Device d = deviceRepo.findByDeviceIdHash(deviceHash).orElseGet(() -> {
            Device nd = new Device();
            nd.setId(UUID.randomUUID().toString());
            nd.setDeviceIdHash(deviceHash);
            nd.setFirstSeenAt(now);
            return nd;
        });
        d.setLastSeenAt(now);
        deviceRepo.save(d);
    }

    private void logEvent(String type, String keyId, String deviceHash, Map<String, Object> meta) {
        try {
            EventLog e = new EventLog();
            e.setId(UUID.randomUUID().toString());
            e.setType(type);
            e.setKeyId(keyId);
            e.setDeviceIdHash(deviceHash);
            e.setMetaJson(mapper.writeValueAsString(meta));
            e.setCreatedAt(clock.millis());
            eventRepo.save(e);
        } catch (Exception ex) {
            log.warn("写事件日志失败: {}", ex.getMessage());
        }
    }

    private static String trimVersion(String v) {
        if (v == null) return null;
        return v.length() > 32 ? v.substring(0, 32) : v;
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }
}
