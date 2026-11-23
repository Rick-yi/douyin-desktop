package com.zmtjl.license;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class AdminPlanBatchTest {
    private static final String ADMIN = "plan-admin-token";
    private static final String DB = "jdbc:h2:mem:plan_" + UUID.randomUUID().toString().replace("-", "")
            + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    private static final Path KEYS_DIR = createTempDir();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> DB);
        r.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
        r.add("spring.datasource.username", () -> "sa");
        r.add("spring.datasource.password", () -> "");
        r.add("app.admin-token", () -> ADMIN);
        r.add("app.key-hmac-secret", () -> "plan-key-secret");
        r.add("app.keys-dir", () -> KEYS_DIR.toString());
        r.add("app.public-base-url", () -> "http://127.0.0.1:8089");
        r.add("app.update-enabled", () -> "true");
        r.add("app.update-latest-version", () -> "0.2.0");
        r.add("app.update-min-version", () -> "0.1.0");
        r.add("app.update-download-url", () -> "https://example.com/Shantuo-0.2.0.exe");
        r.add("app.update-sha256", () -> "a".repeat(64));
    }

    private static Path createTempDir() {
        try {
            return Files.createTempDirectory("plan-keys-");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;

    @Test
    void plansCanBeListedCreatedAndUpdatedButCodeIsImmutable() throws Exception {
        mvc.perform(get("/v1/admin/plans").header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].code").exists());

        Map<String, Object> body = Map.of(
                "code", "vip_test",
                "name", "VIP 测试套餐",
                "features", List.of("intercept", "monitor"),
                "deviceLimit", 3,
                "durationDays", 90);
        MvcResult created = mvc.perform(post("/v1/admin/plans")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(body)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("vip_test"))
                .andExpect(jsonPath("$.features.length()").value(2))
                .andReturn();
        JsonNode node = mapper.readTree(created.getResponse().getContentAsString());
        String id = node.get("id").asText();

        mvc.perform(post("/v1/admin/plans")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(body)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("PLAN_CODE_EXISTS"));

        Map<String, Object> changed = Map.of(
                "code", "vip_test",
                "name", "VIP 新名字",
                "features", List.of("intercept"),
                "deviceLimit", 5,
                "durationDays", 365);
        mvc.perform(put("/v1/admin/plans/" + id)
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(changed)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("VIP 新名字"))
                .andExpect(jsonPath("$.deviceLimit").value(5));

        Map<String, Object> codeChange = Map.of(
                "code", "vip_other",
                "name", "VIP 新名字",
                "features", List.of("intercept"),
                "deviceLimit", 5,
                "durationDays", 365);
        mvc.perform(put("/v1/admin/plans/" + id)
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(codeChange)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("PLAN_CODE_IMMUTABLE"));
    }

    @Test
    void updateManifestForcesOldClients() throws Exception {
        mvc.perform(get("/v1/app/version")
                        .param("platform", "win")
                        .param("channel", "stable")
                        .param("current", "0.0.9"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(true))
                .andExpect(jsonPath("$.latestVersion").value("0.2.0"))
                .andExpect(jsonPath("$.updateAvailable").value(true))
                .andExpect(jsonPath("$.force").value(true))
                .andExpect(jsonPath("$.sha256").value("a".repeat(64)));

        mvc.perform(get("/v1/app/version")
                        .param("current", "0.1.5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.updateAvailable").value(true))
                .andExpect(jsonPath("$.force").value(false));
    }

    @Test
    void keyBatchCanExportExtendAndRevoke() throws Exception {
        mvc.perform(post("/v1/admin/plans")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "code", "batch_plan",
                                "name", "批次测试",
                                "features", List.of("intercept"),
                                "deviceLimit", 1,
                                "durationDays", 30))))
                .andExpect(status().isOk());

        String batch = "BATCH-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        mvc.perform(post("/v1/admin/keys/generate")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of(
                                "plan", "batch_plan", "count", 3, "batch", batch))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.count").value(3))
                .andExpect(jsonPath("$.keys.length()").value(3));

        MvcResult csv = mvc.perform(get("/v1/admin/keys/export")
                        .param("batch", batch)
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(header().exists("Content-Disposition"))
                .andReturn();
        String text = csv.getResponse().getContentAsString();
        assertThat(text).contains(batch).contains("keyHashPrefix");
        assertThat(text.lines().count()).isEqualTo(4); // 表头 + 3 张

        mvc.perform(post("/v1/admin/keys/batch-extend")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("batch", batch, "days", 10))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.count").value(3));

        mvc.perform(post("/v1/admin/keys/batch-revoke")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("batch", batch))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.count").value(3));

        mvc.perform(get("/v1/admin/keys").param("batch", batch).header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].status").value("revoked"))
                .andExpect(jsonPath("$[1].status").value("revoked"))
                .andExpect(jsonPath("$[2].status").value("revoked"));
    }
}
