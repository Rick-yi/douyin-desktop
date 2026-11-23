package com.zmtjl.license;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.domain.LicenseKey;
import com.zmtjl.license.domain.ShopOrder;
import com.zmtjl.license.repo.LicenseKeyRepository;
import com.zmtjl.license.repo.ShopOrderRepository;
import com.zmtjl.license.service.pay.MockPaymentChannel;
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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
class ShopFlowTest {
    private static final String ADMIN = "shop-admin-token";
    private static final String MOCK_SECRET = "shop-mock-secret";
    private static final String DB = "jdbc:h2:mem:shop_" + UUID.randomUUID().toString().replace("-", "")
            + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    private static final Path KEYS_DIR = createTempDir();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> DB);
        r.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
        r.add("spring.datasource.username", () -> "sa");
        r.add("spring.datasource.password", () -> "");
        r.add("app.admin-token", () -> ADMIN);
        r.add("app.key-hmac-secret", () -> "shop-key-secret");
        r.add("app.data-enc-key", () -> "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        r.add("app.keys-dir", () -> KEYS_DIR.toString());
        r.add("app.activate-rate-limit-per-minute", () -> "1000");
        r.add("app.pay-channels", () -> "manual,mock");
        r.add("app.pay-mock-secret", () -> MOCK_SECRET);
        r.add("app.public-base-url", () -> "http://127.0.0.1:8089");
        r.add("app.order-expire-minutes", () -> "30");
    }

    private static Path createTempDir() {
        try {
            return Files.createTempDirectory("shop-keys-");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired ShopOrderRepository orderRepo;
    @Autowired LicenseKeyRepository keyRepo;

    @Test
    void productsAndChannelsArePublic() throws Exception {
        mvc.perform(get("/v1/shop/products"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].priceCents").isNumber());
        mvc.perform(get("/v1/shop/channels"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2));
    }

    @Test
    void createOrderReturnsPayUrlAndToken() throws Exception {
        JsonNode created = createOrder("prod-pro-1y", "mock");
        assertThat(created.get("outTradeNo").asText()).startsWith("O").hasSize(21);
        assertThat(created.get("token").asText()).hasSize(40);
        assertThat(created.get("payUrl").asText()).contains("/v1/pay/mock/checkout");
        assertThat(created.get("amountCents").asLong()).isEqualTo(29900);
        assertThat(created.get("status").asText()).isEqualTo("created");
    }

    @Test
    void buyerQueryRequiresToken() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "mock");
        String no = created.get("outTradeNo").asText();
        String token = created.get("token").asText();

        mvc.perform(get("/v1/shop/orders/" + no).param("token", "wrong"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("ORDER_TOKEN_INVALID"));

        mvc.perform(get("/v1/shop/orders/" + no).param("token", token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("created"))
                .andExpect(jsonPath("$.key").doesNotExist());
    }

    @Test
    void notifyIssuesKeyAndIsIdempotent() throws Exception {
        JsonNode created = createOrder("prod-pro-1y", "mock");
        String no = created.get("outTradeNo").asText();
        String token = created.get("token").asText();
        long beforeKeys = keyRepo.count();

        String eventId = "evt_" + UUID.randomUUID();
        notifyMock(eventId, no, 29900, "TX1").andExpect(status().isOk())
                .andExpect(content().string("success"));

        JsonNode order = buyerOrder(no, token);
        assertThat(order.get("status").asText()).isEqualTo("paid");
        assertThat(order.get("key").asText()).matches("ZMTJ-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}");
        assertThat(keyRepo.count()).isEqualTo(beforeKeys + 1);

        // 同一个 eventId 重放
        notifyMock(eventId, no, 29900, "TX1").andExpect(status().isOk());
        // 换一个 eventId 重复通知同一订单
        notifyMock("evt_" + UUID.randomUUID(), no, 29900, "TX1").andExpect(status().isOk());

        assertThat(keyRepo.count()).isEqualTo(beforeKeys + 1);
        assertThat(buyerOrder(no, token).get("key").asText())
                .isEqualTo(order.get("key").asText());
    }

    @Test
    void amountMismatchRejected() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "mock");
        String no = created.get("outTradeNo").asText();

        notifyMock("evt_" + UUID.randomUUID(), no, 1, "TX")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("AMOUNT_MISMATCH"));

        assertThat(orderRepo.findByOutTradeNo(no).orElseThrow().getStatus())
                .isEqualTo(ShopOrder.STATUS_CREATED);
    }

    @Test
    void badSignatureRejected() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "mock");
        String no = created.get("outTradeNo").asText();
        String raw = mapper.writeValueAsString(Map.of(
                "eventId", "evt_" + UUID.randomUUID(),
                "outTradeNo", no,
                "amountCents", 9900,
                "transactionId", "TX"));

        mvc.perform(post("/v1/pay/notify/mock")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header(MockPaymentChannel.SIGN_HEADER, "deadbeef")
                        .content(raw))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("SIGN_INVALID"));
    }

    @Test
    void mockCheckoutFlowEndToEnd() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "mock");
        String no = created.get("outTradeNo").asText();
        String token = created.get("token").asText();

        mvc.perform(get("/v1/pay/mock/checkout").param("order", no).param("token", token))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("模拟支付")));

        mvc.perform(post("/v1/pay/mock/pay")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"outTradeNo\":\"" + no + "\",\"token\":\"" + token + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));

        JsonNode order = buyerOrder(no, token);
        assertThat(order.get("status").asText()).isEqualTo("paid");
        assertThat(order.get("key").asText()).startsWith("ZMTJ-");
    }

    @Test
    void manualChannelMarkPaid() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "manual");
        String no = created.get("outTradeNo").asText();
        String token = created.get("token").asText();
        assertThat(created.hasNonNull("payUrl")).isFalse();

        mvc.perform(post("/v1/admin/orders/" + no + "/mark-paid")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"transactionId\":\"OFFLINE-1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("paid"));

        assertThat(buyerOrder(no, token).get("key").asText()).startsWith("ZMTJ-");
    }

    @Test
    void adminEndpointsRequireToken() throws Exception {
        mvc.perform(get("/v1/admin/orders"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void refundRevokesUnusedKey() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "manual");
        String no = created.get("outTradeNo").asText();
        mvc.perform(post("/v1/admin/orders/" + no + "/mark-paid")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk());

        String keyId = orderRepo.findByOutTradeNo(no).orElseThrow().getKeyId();
        LicenseKey before = keyRepo.findById(keyId).orElseThrow();
        assertThat(before.getStatus()).isEqualTo(LicenseKey.STATUS_UNUSED);

        mvc.perform(post("/v1/admin/orders/" + no + "/refund")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.keyRevoked").value(true))
                .andExpect(jsonPath("$.status").value("refunded"));

        assertThat(keyRepo.findById(keyId).orElseThrow().getStatus())
                .isEqualTo(LicenseKey.STATUS_REVOKED);
    }

    @Test
    void cancelUnpaidAndRejectLateSettle() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "manual");
        String no = created.get("outTradeNo").asText();

        mvc.perform(post("/v1/admin/orders/" + no + "/cancel")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("cancelled"));

        mvc.perform(post("/v1/admin/orders/" + no + "/mark-paid")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("ORDER_NOT_PAYABLE"));
    }

    @Test
    void expiredOrderIsClosedOnRead() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "mock");
        String no = created.get("outTradeNo").asText();
        String token = created.get("token").asText();

        ShopOrder o = orderRepo.findByOutTradeNo(no).orElseThrow();
        o.setExpiresAt(System.currentTimeMillis() - 1000);
        orderRepo.save(o);

        assertThat(buyerOrder(no, token).get("status").asText()).isEqualTo("closed");
    }

    @Test
    void revealKeyMatchesBuyerView() throws Exception {
        JsonNode created = createOrder("prod-standard-30d", "mock");
        String no = created.get("outTradeNo").asText();
        String token = created.get("token").asText();
        notifyMock("evt_" + UUID.randomUUID(), no, 9900, "TX").andExpect(status().isOk());

        String buyerKey = buyerOrder(no, token).get("key").asText();
        MvcResult res = mvc.perform(get("/v1/admin/orders/" + no + "/key")
                        .header("X-Admin-Token", ADMIN))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(mapper.readTree(res.getResponse().getContentAsString()).get("key").asText())
                .isEqualTo(buyerKey);
    }

    @Test
    void adminCanCreateAndUpdateProduct() throws Exception {
        MvcResult res = mvc.perform(post("/v1/admin/products")
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"code":"trial-7d","name":"试用版 · 7 天","planCode":"trial","priceCents":100}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.priceCents").value(100))
                .andReturn();
        String id = mapper.readTree(res.getResponse().getContentAsString()).get("id").asText();

        mvc.perform(put("/v1/admin/products/" + id)
                        .header("X-Admin-Token", ADMIN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"code":"trial-7d","name":"试用版 · 7 天","planCode":"trial","priceCents":900}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.priceCents").value(900));
    }

    // ── helpers ──

    private JsonNode createOrder(String productId, String channel) throws Exception {
        MvcResult res = mvc.perform(post("/v1/shop/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":\"" + productId + "\",\"channel\":\"" + channel + "\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(res.getResponse().getContentAsString());
    }

    private JsonNode buyerOrder(String no, String token) throws Exception {
        MvcResult res = mvc.perform(get("/v1/shop/orders/" + no).param("token", token))
                .andExpect(status().isOk())
                .andReturn();
        return mapper.readTree(res.getResponse().getContentAsString());
    }

    private org.springframework.test.web.servlet.ResultActions notifyMock(
            String eventId, String no, long amountCents, String tx) throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("eventId", eventId);
        payload.put("outTradeNo", no);
        payload.put("amountCents", amountCents);
        payload.put("transactionId", tx);
        String raw = mapper.writeValueAsString(payload);
        String sign = MockPaymentChannel.sign(raw, MOCK_SECRET);
        return mvc.perform(post("/v1/pay/notify/mock")
                .contentType(MediaType.APPLICATION_JSON)
                .header(MockPaymentChannel.SIGN_HEADER, sign)
                .content(raw));
    }
}
