package com.zmtjl.license;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class AppReleaseFlowTest {
    private static final String ADMIN = "release-admin-token";
    private static final String DB = "jdbc:h2:mem:release_" + UUID.randomUUID().toString().replace("-", "")
            + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    private static final Path KEYS_DIR = createTempDir();
    private static final Path RELEASES_DIR = createTempDir();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> DB);
        r.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
        r.add("spring.datasource.username", () -> "sa");
        r.add("spring.datasource.password", () -> "");
        r.add("app.admin-token", () -> ADMIN);
        r.add("app.key-hmac-secret", () -> "release-key-secret");
        r.add("app.keys-dir", () -> KEYS_DIR.toString());
        r.add("app.releases-dir", () -> RELEASES_DIR.toString());
        r.add("app.public-base-url", () -> "http://127.0.0.1:8089");
        r.add("app.update-enabled", () -> "false");
    }

    private static Path createTempDir() {
        try {
            return Files.createTempDirectory("release-test-");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;

    private MvcResult upload(String version, String min, boolean force, boolean publish) throws Exception {
        MockMultipartFile file = new MockMultipartFile(
                "file", "Shantuo-" + version + ".exe",
                "application/octet-stream", ("installer-" + version).getBytes(StandardCharsets.UTF_8));
        return mvc.perform(multipart("/v1/admin/app/releases")
                        .file(file)
                        .param("version", version)
                        .param("minVersion", min)
                        .param("force", String.valueOf(force))
                        .param("publish", String.valueOf(publish))
                        .param("notes", "test release")
                        .header("X-Admin-Token", ADMIN))
                .andReturn();
    }

    @Test
    void uploadPublishManifestAndDownload() throws Exception {
        MvcResult uploaded = upload("0.2.0", "0.1.0", false, true);
        assertThat(uploaded.getResponse().getStatus()).isEqualTo(200);
        JsonNode r = mapper.readTree(uploaded.getResponse().getContentAsString());
        assertThat(r.get("active").asBoolean()).isTrue();
        assertThat(r.get("sha256").asText()).hasSize(64);
        String releaseId = r.get("id").asText();
        assertThat(r.get("downloadUrl").asText())
                .isEqualTo("http://127.0.0.1:8089/v1/app/download/" + releaseId);

        mvc.perform(get("/v1/app/version").param("current", "0.1.5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(true))
                .andExpect(jsonPath("$.latestVersion").value("0.2.0"))
                .andExpect(jsonPath("$.updateAvailable").value(true))
                .andExpect(jsonPath("$.force").value(false));

        mvc.perform(get("/v1/app/version").param("current", "0.0.9"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.force").value(true));

        MvcResult download = mvc.perform(get("/v1/app/download/" + releaseId))
                .andExpect(status().isOk())
                .andExpect(header().exists("Content-Disposition"))
                .andReturn();
        assertThat(download.getResponse().getContentAsByteArray())
                .isEqualTo("installer-0.2.0".getBytes(StandardCharsets.UTF_8));

        mvc.perform(post("/v1/admin/app/releases/" + releaseId + "/unpublish")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false));

        mvc.perform(get("/v1/app/version").param("current", "0.1.5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false));
    }

    @Test
    void duplicateVersionAndInvalidFileAreRejected() throws Exception {
        assertThat(upload("0.3.0", "", false, true).getResponse().getStatus()).isEqualTo(200);
        assertThat(upload("0.3.0", "", false, true).getResponse().getStatus())
                .isEqualTo(400);

        MockMultipartFile bad = new MockMultipartFile(
                "file", "installer.txt", "text/plain", "x".getBytes());
        mvc.perform(multipart("/v1/admin/app/releases")
                        .file(bad)
                        .param("version", "0.3.1")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("FILE_TYPE_INVALID"));
    }

    @Test
    void inactiveReleaseCanBeDeleted() throws Exception {
        MvcResult uploaded = upload("0.5.0", "", false, false);
        assertThat(uploaded.getResponse().getStatus()).isEqualTo(200);
        String id = mapper.readTree(uploaded.getResponse().getContentAsString()).get("id").asText();

        mvc.perform(delete("/v1/admin/app/releases/" + id)
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));

        String list = mvc.perform(get("/v1/admin/app/releases").header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        assertThat(list).doesNotContain(id);
    }

    @Test
    void forcedUploadOverridesMinVersion() throws Exception {
        MvcResult uploaded = upload("0.4.0", "", true, true);
        assertThat(uploaded.getResponse().getStatus()).isEqualTo(200);
        JsonNode r = mapper.readTree(uploaded.getResponse().getContentAsString());
        assertThat(r.get("minVersion").asText()).isEqualTo("0.4.0");
        assertThat(r.get("forceUpdate").asBoolean()).isTrue();

        mvc.perform(get("/v1/app/version").param("current", "0.4.0"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.updateAvailable").value(false))
                .andExpect(jsonPath("$.force").value(false));

        mvc.perform(get("/v1/app/version").param("current", "0.3.9"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.updateAvailable").value(true))
                .andExpect(jsonPath("$.force").value(true));
    }
}
