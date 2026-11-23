package com.zmtjl.license;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.repo.EventLogRepository;
import com.zmtjl.license.repo.JumpClickRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class JumpCardFlowTest {
    private static final String ADMIN = "jump-admin-token";
    private static final String BASE = "http://127.0.0.1:8089";
    private static final String DB = "jdbc:h2:mem:jump_" + UUID.randomUUID().toString().replace("-", "")
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
        r.add("app.key-hmac-secret", () -> "jump-key-secret");
        r.add("app.keys-dir", () -> KEYS_DIR.toString());
        r.add("app.releases-dir", () -> RELEASES_DIR.toString());
        r.add("app.activate-rate-limit-per-minute", () -> "1000");
        r.add("app.public-base-url", () -> BASE);
    }

    private static Path createTempDir() {
        try {
            return Files.createTempDirectory("jump-keys-");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired JumpClickRepository clickRepo;
    @Autowired EventLogRepository eventRepo;

    @Test
    void adminEndpointsRequireToken() throws Exception {
        mvc.perform(get("/v1/admin/jump-cards"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));

        mvc.perform(post("/v1/admin/jump-cards")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void adminUploadReturnsPublicImageUrl() throws Exception {
        byte[] png = new byte[]{
                (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A,
                0, 0, 0, 0, 0, 0, 0, 0,
        };
        MockMultipartFile file = new MockMultipartFile("file", "qr.png", "image/png", png);
        MvcResult res = mvc.perform(multipart("/v1/admin/uploads")
                        .file(file)
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.url", containsString("/uploads/card-images/")))
                .andReturn();

        JsonNode body = mapper.readTree(res.getResponse().getContentAsString());
        String path = URI.create(body.get("url").asText()).getPath();
        mvc.perform(get(path))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Content-Type", containsString("image/png")));

        MockMultipartFile bad = new MockMultipartFile("file", "fake.png", "image/png",
                "not an image".getBytes());
        mvc.perform(multipart("/v1/admin/uploads")
                        .file(bad)
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isBadRequest());
    }

    @Test
    void wecomCardRendersLandingPage() throws Exception {
        String code = "C" + random(7);
        String launch = "weixin://dl/business/?t=test";
        Map<String, Object> body = payload(code, launch, "active");
        body.put("targetType", "wecom");
        body.put("qrImageUrl", "https://cdn.example.com/wecom-qr.png");

        mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(body)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.targetType").value("wecom"))
                .andExpect(jsonPath("$.targetUrl").value(launch));

        mvc.perform(get("/r/" + code))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
                .andExpect(content().string(containsString("企业微信")))
                .andExpect(content().string(containsString("打开微信添加")))
                .andExpect(content().string(containsString(launch)));
    }

    @Test
    void createRedirectAndTrackClick() throws Exception {
        String code = "J" + random(7);
        JsonNode card = createCard(code, "https://example.com/landing?from=test");

        assertThat(card.get("code").asText()).isEqualTo(code);
        assertThat(card.get("shortUrl").asText()).isEqualTo(BASE + "/r/" + code);
        assertThat(card.get("clickCount").asLong()).isZero();
        assertThat(card.get("status").asText()).isEqualTo("active");

        // 公开列表能看到，但不暴露真实目标地址
        mvc.perform(get("/v1/jump/cards").param("group", "测试组"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.code == '" + code + "')]").isNotEmpty())
                .andExpect(jsonPath("$[0].targetUrl").doesNotExist())
                .andExpect(jsonPath("$[0].shortUrl").exists());

        // 短链 302 到目标地址
        mvc.perform(get("/r/" + code)
                        .header("Referer", "https://ref.example.com/page?token=secret#frag"))
                .andExpect(status().isFound())
                .andExpect(header().string("Location", "https://example.com/landing?from=test"));

        // 点击计数与明细
        mvc.perform(get("/v1/admin/jump-cards/" + card.get("id").asText())
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.card.clickCount").value(1))
                .andExpect(jsonPath("$.totalClicks").value(1))
                .andExpect(jsonPath("$.recentClicks.length()").value(1))
                .andExpect(jsonPath("$.recentClicks[0].ip").exists())
                .andExpect(jsonPath("$.recentClicks[0].referer")
                        .value("https://ref.example.com/page"));

        // 明细里不落原始 IP，只保留 HMAC 指纹
        var click = clickRepo.findTop100ByCardIdOrderByClickedAtDesc(card.get("id").asText()).get(0);
        assertThat(click.getIp()).matches("[0-9a-f]{64}").doesNotContain("127.0.0.1");
        assertThat(click.getReferer()).isEqualTo("https://ref.example.com/page");

        // 小写 code 也能解析
        mvc.perform(get("/r/" + code.toLowerCase()))
                .andExpect(status().isFound());
    }

    @Test
    void personalWechatQrRendersLandingPage() throws Exception {
        String code = "W" + random(7);
        String qr = "https://cdn.example.com/wechat-qr.png";
        Map<String, Object> body = payload(code, "", "active");
        body.put("targetType", "wechat_qr");
        body.put("qrImageUrl", qr);

        JsonNode card = mapper.readTree(mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(body)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.targetType").value("wechat_qr"))
                .andExpect(jsonPath("$.qrImageUrl").value(qr))
                .andExpect(jsonPath("$.targetUrl").value(""))
                .andReturn().getResponse().getContentAsString());

        String id = card.get("id").asText();
        mvc.perform(get("/r/" + code))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
                .andExpect(header().doesNotExist("Location"))
                .andExpect(content().string(containsString(qr)))
                .andExpect(content().string(containsString("weixin://")))
                .andExpect(content().string(containsString("打开微信")))
                .andExpect(content().string(containsString("保存二维码")))
                .andExpect(content().string(containsString("download=\"wechat-qr.jpg\"")))
                .andExpect(content().string(containsString("长按二维码识别添加")));

        // 落地页点击也计数
        mvc.perform(get("/v1/admin/jump-cards/" + id).header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.card.clickCount").value(1));

        // 公开列表不暴露二维码图片
        mvc.perform(get("/v1/jump/cards"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.code == '" + code + "')]").isNotEmpty())
                .andExpect(jsonPath("$[?(@.code == '" + code + "')].qrImageUrl").doesNotExist());

        // 缺少二维码图片必须拒绝
        Map<String, Object> bad = payload("B" + random(7), "", "active");
        bad.put("targetType", "wechat_qr");
        mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(bad)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("URL_REQUIRED"));
    }

    @Test
    void updateTargetKeepsShortCode() throws Exception {
        String code = "U" + random(7);
        JsonNode card = createCard(code, "https://example.com/old");
        String id = card.get("id").asText();

        Map<String, Object> body = payload(code, "https://example.com/new", "active");
        body.put("title", "新标题");
        mvc.perform(put("/v1/admin/jump-cards/" + id)
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(body)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(code))
                .andExpect(jsonPath("$.targetUrl").value("https://example.com/new"))
                .andExpect(jsonPath("$.title").value("新标题"));

        mvc.perform(get("/r/" + code))
                .andExpect(status().isFound())
                .andExpect(header().string("Location", "https://example.com/new"));
    }

    @Test
    void disabledCardStopsRedirectAndIsHidden() throws Exception {
        String code = "D" + random(7);
        JsonNode card = createCard(code, "https://example.com/off");
        String id = card.get("id").asText();

        mvc.perform(put("/v1/admin/jump-cards/" + id)
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(payload(code, "https://example.com/off", "disabled"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("disabled"));

        mvc.perform(get("/r/" + code))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML));

        mvc.perform(get("/v1/jump/cards"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.code == '" + code + "')]").isEmpty());
    }

    @Test
    void rejectsInvalidInputAndDuplicateCode() throws Exception {
        String code = "V" + random(7);
        createCard(code, "https://example.com/ok");

        // 重复 code
        mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(payload(code, "https://example.com/x", "active"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("CODE_EXISTS"));

        // 非 http 协议
        mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(payload("BAD" + random(5), "ftp://example.com/x", "active"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("URL_INVALID"));

        // 非法短链标识
        mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(payload("bad code!", "https://example.com/x", "active"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("CODE_INVALID"));
    }

    @Test
    void deleteRemovesCardAndClicks() throws Exception {
        String code = "X" + random(7);
        JsonNode card = createCard(code, "https://example.com/del");
        String id = card.get("id").asText();

        mvc.perform(get("/r/" + code)).andExpect(status().isFound());
        assertThat(clickRepo.countByCardId(id)).isEqualTo(1);

        mvc.perform(delete("/v1/admin/jump-cards/" + id).header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));

        mvc.perform(get("/v1/admin/jump-cards/" + id).header("X-Admin-Token", ADMIN))
                .andExpect(status().isNotFound());
        mvc.perform(get("/r/" + code)).andExpect(status().isNotFound());
        assertThat(clickRepo.countByCardId(id)).isZero();
    }


    @Test
    void dedupesRapidClicksFromSameIp() throws Exception {
        String code = "K" + random(7);
        JsonNode card = createCard(code, "https://example.com/dedupe");
        String id = card.get("id").asText();

        mvc.perform(get("/r/" + code)).andExpect(status().isFound());
        mvc.perform(get("/r/" + code)).andExpect(status().isFound());

        assertThat(clickRepo.countByCardId(id)).isEqualTo(1);
    }

    @Test
    void publicCardsSupportEtagAndAdminListPaginates() throws Exception {
        createCard("E" + random(7), "https://example.com/etag");

        MvcResult first = mvc.perform(get("/v1/jump/cards").param("group", "测试组"))
                .andExpect(status().isOk())
                .andExpect(header().exists("ETag"))
                .andReturn();
        String etag = first.getResponse().getHeader("ETag");

        mvc.perform(get("/v1/jump/cards").param("group", "测试组")
                        .header("If-None-Match", etag))
                .andExpect(status().isNotModified());

        mvc.perform(get("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .param("page", "0")
                        .param("size", "1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.content.length()").value(1))
                .andExpect(jsonPath("$.total").isNumber())
                .andExpect(jsonPath("$.totalPages").isNumber());
    }

    @Test
    void adminMutationsAreAuditedWithoutToken() throws Exception {
        String code = "A" + random(7);
        createCard(code, "https://example.com/audit");

        boolean found = eventRepo.findTop100ByOrderByCreatedAtDesc().stream()
                .anyMatch(e -> "admin_http".equals(e.getType())
                        && e.getMetaJson() != null
                        && e.getMetaJson().contains("/v1/admin/jump-cards")
                        && e.getMetaJson().contains("POST"));
        assertThat(found).isTrue();
    }

    // ── helpers ──

    private JsonNode createCard(String code, String targetUrl) throws Exception {
        MvcResult res = mvc.perform(post("/v1/admin/jump-cards")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(payload(code, targetUrl, "active"))))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(res.getResponse().getContentAsString());
    }

    private static Map<String, Object> payload(String code, String targetUrl, String status) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("name", "测试跳转卡 " + code);
        m.put("targetUrl", targetUrl);
        m.put("title", "点我咨询");
        m.put("description", "测试描述");
        m.put("coverUrl", "https://example.com/cover.png");
        m.put("groupName", "测试组");
        m.put("status", status);
        return m;
    }

    private static String random(int len) {
        String alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        StringBuilder sb = new StringBuilder(len);
        for (int i = 0; i < len; i++) {
            sb.append(alphabet.charAt((int) (Math.random() * alphabet.length())));
        }
        return sb.toString();
    }
}
