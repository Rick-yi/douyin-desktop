package com.zmtjl.license.crypto;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.web.ApiException;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.*;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 授权令牌签发与验签（Ed25519）
 *
 * 令牌 = base64url(payloadJson) + "." + base64url(signature)
 * 客户端内置公钥，验签后读取 features / exp / device。
 *
 * 注意：验签只校验签名，不校验 exp。心跳允许持过期令牌来续签，
 * 否则用户离线超过有效期就再也回不来（只能重新输入卡密）。
 */
@Component
public class TokenService {
    private static final Logger log = LoggerFactory.getLogger(TokenService.class);

    private final AppProperties props;
    private final ObjectMapper mapper;
    private PrivateKey privateKey;
    private PublicKey publicKey;

    public TokenService(AppProperties props, ObjectMapper mapper) {
        this.props = props;
        this.mapper = mapper;
    }

    @PostConstruct
    void init() throws Exception {
        Path dir = Path.of(props.getKeysDir());
        Files.createDirectories(dir);
        Path priv = dir.resolve("ed25519-private.pem");
        Path pub = dir.resolve("ed25519-public.pem");

        if (Files.exists(priv) && Files.exists(pub)) {
            privateKey = readPrivate(priv);
            publicKey = readPublic(pub);
            log.info("已加载 Ed25519 密钥: {}", priv.toAbsolutePath());
        } else {
            KeyPairGenerator kpg = KeyPairGenerator.getInstance("Ed25519");
            KeyPair kp = kpg.generateKeyPair();
            privateKey = kp.getPrivate();
            publicKey = kp.getPublic();
            Files.writeString(priv, toPem("PRIVATE KEY", privateKey.getEncoded()));
            Files.writeString(pub, toPem("PUBLIC KEY", publicKey.getEncoded()));
            log.warn("首次启动，已生成 Ed25519 密钥对: {}（请备份私钥）", dir.toAbsolutePath());
        }
    }

    public String publicKeyPem() {
        return toPem("PUBLIC KEY", publicKey.getEncoded());
    }

    /** 签发令牌，返回 [token, expMillis] */
    public Issued issue(Map<String, Object> claims) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>(claims);
            byte[] payloadBytes = mapper.writeValueAsBytes(payload);
            Signature sig = Signature.getInstance("Ed25519");
            sig.initSign(privateKey);
            sig.update(payloadBytes);
            byte[] signature = sig.sign();

            Base64.Encoder enc = Base64.getUrlEncoder().withoutPadding();
            String token = enc.encodeToString(payloadBytes) + "." + enc.encodeToString(signature);
            long exp = ((Number) payload.get("exp")).longValue();
            return new Issued(token, exp);
        } catch (Exception e) {
            throw new IllegalStateException("令牌签发失败", e);
        }
    }

    /** 验签并解析 payload；只校验签名，不校验有效期 */
    public Map<String, Object> verify(String token) {
        if (token == null || token.isBlank()) {
            throw new ApiException("TOKEN_INVALID", "缺少授权令牌");
        }
        int dot = token.indexOf('.');
        if (dot <= 0 || dot == token.length() - 1) {
            throw new ApiException("TOKEN_INVALID", "授权令牌格式错误");
        }
        try {
            Base64.Decoder dec = Base64.getUrlDecoder();
            byte[] payloadBytes = dec.decode(token.substring(0, dot));
            byte[] signature = dec.decode(token.substring(dot + 1));

            Signature sig = Signature.getInstance("Ed25519");
            sig.initVerify(publicKey);
            sig.update(payloadBytes);
            if (!sig.verify(signature)) {
                throw new ApiException("TOKEN_INVALID", "授权令牌签名无效");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> payload = mapper.readValue(payloadBytes, Map.class);
            return payload;
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            throw new ApiException("TOKEN_INVALID", "授权令牌无法解析");
        }
    }

    /** 签发时的基础字段 */
    public Map<String, Object> baseClaims(String keyId, String planCode, Object features,
                                          String deviceHash, long nowMillis, int ttlHours,
                                          long keyExpireAt) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1);
        m.put("keyId", keyId);
        m.put("plan", planCode);
        m.put("features", features);
        m.put("device", deviceHash);
        m.put("iat", nowMillis / 1000);
        m.put("exp", (nowMillis + ttlHours * 3600_000L) / 1000);
        m.put("keyExpireAt", keyExpireAt);
        return m;
    }

    private static String toPem(String type, byte[] der) {
        String b64 = Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(der);
        return "-----BEGIN " + type + "-----\n" + b64 + "\n-----END " + type + "-----\n";
    }

    private static PrivateKey readPrivate(Path p) throws Exception {
        String pem = Files.readString(p)
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(pem);
        return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    private static PublicKey readPublic(Path p) throws Exception {
        String pem = Files.readString(p)
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(pem);
        return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
    }

    public record Issued(String token, long expiresAt) {}
}
