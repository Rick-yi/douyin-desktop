package com.zmtjl.license;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.crypto.TokenService;
import com.zmtjl.license.domain.LicenseKey;
import com.zmtjl.license.repo.LicenseKeyRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class LicenseFlowTest {
    private static final String ADMIN = "test-admin-token";
    private static final String DB = "jdbc:h2:mem:lic_" + UUID.randomUUID().toString().replace("-", "")
            + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    private static final Path KEYS_DIR = createTempDir();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> DB);
        r.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
        r.add("spring.datasource.username", () -> "sa");
        r.add("spring.datasource.password", () -> "");
        r.add("app.admin-token", () -> ADMIN);
        r.add("app.key-hmac-secret", () -> "test-secret");
        r.add("app.keys-dir", () -> KEYS_DIR.toString());
        r.add("app.activate-rate-limit-per-minute", () -> "1000");
        r.add("app.token-ttl-hours", () -> "168");
    }

    private static Path createTempDir() {
        try {
            return Files.createTempDirectory("license-keys-");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired TokenService tokenService;
    @Autowired LicenseKeyRepository keyRepo;

    // ── 管理接口 ──

    @Test
    void adminRequiresToken() throws Exception {
        mvc.perform(post("/v1/admin/keys/generate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"plan\":\"pro\",\"count\":1}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
    }

    @Test
    void generateKeysAndNeverStorePlaintext() throws Exception {
        JsonNode res = generate("standard", 3);
        assertThat(res.get("count").asInt()).isEqualTo(3);
        for (JsonNode k : res.get("keys")) {
            String key = k.get("key").asText();
            assertThat(key).matches("ZMTJ-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}");

            LicenseKey entity = keyRepo.findById(k.get("id").asText()).orElseThrow();
            // DB 里只有 64 位 HMAC，没有明文
            assertThat(entity.getKeyHash()).hasSize(64).doesNotContain(key);
            assertThat(entity.getNote()).isNull();
            assertThat(entity.getStatus()).isEqualTo(LicenseKey.STATUS_UNUSED);
        }
    }

    // ── 激活与心跳 ──

    @Test
    void activateIssuesVerifiableToken() throws Exception {
        String key = firstKey(generate("pro", 1));
        MvcResult res = activate(key, "device-a").andExpect(status().isOk()).andReturn();
        JsonNode body = mapper.readTree(res.getResponse().getContentAsString());

        assertThat(body.get("token").asText()).isNotBlank();
        assertThat(body.get("plan").asText()).isEqualTo("pro");
        assertThat(body.get("deviceLimit").asInt()).isEqualTo(2);
        assertThat(body.get("keyExpireAt").asLong()).isGreaterThan(System.currentTimeMillis());

        List<String> features = mapper.convertValue(body.get("features"),
                mapper.getTypeFactory().constructCollectionType(List.class, String.class));
        assertThat(features).contains("intercept", "monitor", "proxy");

        Map<String, Object> claims = tokenService.verify(body.get("token").asText());
        assertThat(claims.get("plan")).isEqualTo("pro");
        assertThat(claims.get("device")).isEqualTo("device-a");
    }

    @Test
    void sameDeviceDoesNotConsumeSecondSlot() throws Exception {
        String key = firstKey(generate("standard", 1));
        activate(key, "device-a").andExpect(status().isOk());
        activate(key, "device-a").andExpect(status().isOk());

        String id = keyIdOf(key);
        LicenseKey entity = keyRepo.findById(id).orElseThrow();
        assertThat(entity.getStatus()).isEqualTo(LicenseKey.STATUS_ACTIVE);
    }

    @Test
    void deviceLimitEnforced() throws Exception {
        String key = firstKey(generate("standard", 1)); // 标准版 1 台
        activate(key, "device-a").andExpect(status().isOk());
        activate(key, "device-b")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("DEVICE_LIMIT_REACHED"));
    }

    @Test
    void deactivateFreesSlot() throws Exception {
        String key = firstKey(generate("standard", 1));
        activate(key, "device-a").andExpect(status().isOk());
        String token = activate(key, "device-a").andReturn().getResponse().getContentAsString();
        String realToken = mapper.readTree(token).get("token").asText();

        mvc.perform(post("/v1/license/deactivate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"" + realToken + "\",\"deviceId\":\"device-a\"}"))
                .andExpect(status().isOk());

        activate(key, "device-b").andExpect(status().isOk());
    }

    @Test
    void heartbeatRenewsAndRejectsOtherDevice() throws Exception {
        String key = firstKey(generate("pro", 1));
        String token = activate(key, "device-a").andReturn().getResponse().getContentAsString();
        String t = mapper.readTree(token).get("token").asText();

        mvc.perform(post("/v1/license/heartbeat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"" + t + "\",\"deviceId\":\"device-a\",\"appVersion\":\"0.1.0\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").isNotEmpty());

        mvc.perform(post("/v1/license/heartbeat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"" + t + "\",\"deviceId\":\"device-b\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("DEVICE_MISMATCH"));
    }

    // ── 吊销与过期 ──

    @Test
    void revokedKeyCannotHeartbeat() throws Exception {
        String key = firstKey(generate("pro", 1));
        String body = activate(key, "device-a").andReturn().getResponse().getContentAsString();
        String t = mapper.readTree(body).get("token").asText();

        mvc.perform(post("/v1/admin/keys/" + keyIdOf(key) + "/revoke")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk());

        mvc.perform(post("/v1/license/heartbeat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"" + t + "\",\"deviceId\":\"device-a\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("KEY_REVOKED"));
    }

    @Test
    void expiredKeyRejected() throws Exception {
        String key = firstKey(generate("standard", 1));
        String id = keyIdOf(key);
        LicenseKey entity = keyRepo.findById(id).orElseThrow();
        entity.setStatus(LicenseKey.STATUS_ACTIVE);
        entity.setExpireAt(System.currentTimeMillis() - 1000);
        keyRepo.save(entity);

        activate(key, "device-a")
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("KEY_EXPIRED"));
    }

    @Test
    void unknownKeyRejected() throws Exception {
        activate("ZMTJ-AAAA-BBBB-CCCC-DDDD", "device-a")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("KEY_NOT_FOUND"));
    }

    @Test
    void extendUnusedKeyAddsDaysBeforeActivation() throws Exception {
        String key = firstKey(generate("trial", 1)); // 试用 7 天
        mvc.perform(post("/v1/admin/keys/" + keyIdOf(key) + "/extend")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"days\":3}"))
                .andExpect(status().isOk());

        String body = activate(key, "device-a").andReturn().getResponse().getContentAsString();
        long expireAt = mapper.readTree(body).get("keyExpireAt").asLong();
        long expected = System.currentTimeMillis() + 10L * 86_400_000L;
        assertThat(expireAt).isBetween(expected - 120_000L, expected + 120_000L);
    }

    @Test
    void publicKeyEndpointReturnsPem() throws Exception {
        mvc.perform(get("/v1/license/public-key"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.algorithm").value("Ed25519"))
                .andExpect(jsonPath("$.pem").value(org.hamcrest.Matchers.containsString("BEGIN PUBLIC KEY")));
    }

    // ── helpers ──

    private JsonNode generate(String plan, int count) throws Exception {
        MvcResult res = mvc.perform(post("/v1/admin/keys/generate")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"plan\":\"" + plan + "\",\"count\":" + count + "}"))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(res.getResponse().getContentAsString());
    }

    private static String firstKey(JsonNode generated) {
        return generated.get("keys").get(0).get("key").asText();
    }

    private ResultActions activate(String key, String device) throws Exception {
        return mvc.perform(post("/v1/license/activate")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"key\":\"" + key + "\",\"deviceId\":\"" + device + "\",\"appVersion\":\"0.1.0\"}"));
    }

    /** 通过管理接口查回 keyId（不依赖内部哈希实现） */
    private String keyIdOf(String key) throws Exception {
        MvcResult res = mvc.perform(get("/v1/admin/keys/lookup")
                        .header("X-Admin-Token", ADMIN)
                        .param("key", key))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(res.getResponse().getContentAsString()).get("id").asText();
    }
}
