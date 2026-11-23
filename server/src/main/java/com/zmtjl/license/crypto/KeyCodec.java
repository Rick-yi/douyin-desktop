package com.zmtjl.license.crypto;

import com.zmtjl.license.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;

/**
 * 卡密编解码
 *
 * 格式：ZMTJ-XXXX-XXXX-XXXX-XXXX（Crockford Base32，去掉易混的 I/L/O/U）
 * 数据库只存 HMAC-SHA256(pepper, 规范化后的卡密)，不存明文。
 */
@Component
public class KeyCodec {
    private static final Logger log = LoggerFactory.getLogger(KeyCodec.class);
    private static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private static final String PREFIX = "ZMTJ";
    private static final int PAYLOAD_LEN = 16;

    private final SecureRandom random = new SecureRandom();
    private final byte[] hmacKey;
    private final boolean devSecret;

    public KeyCodec(AppProperties props) {
        String secret = props.getKeyHmacSecret();
        this.devSecret = secret == null || secret.isBlank();
        if (this.devSecret) {
            // 开发默认值：生产必须通过 KEY_HMAC_SECRET 覆盖
            secret = "dev-only-change-me";
            log.warn("未配置 KEY_HMAC_SECRET，正在使用开发默认值；生产环境必须覆盖");
        }
        this.hmacKey = secret.getBytes(StandardCharsets.UTF_8);
    }

    public boolean isDevSecret() {
        return devSecret;
    }

    /** 去掉前缀、连字符，统一大小写，并处理易混字符 */
    public String normalize(String raw) {
        if (raw == null) return "";
        String s = raw.toUpperCase(Locale.ROOT).replaceAll("[^0-9A-Z]", "");
        if (s.startsWith(PREFIX)) s = s.substring(PREFIX.length());
        return s.replace('I', '1').replace('L', '1').replace('O', '0');
    }

    public boolean isValid(String normalized) {
        if (normalized == null || normalized.length() != PAYLOAD_LEN) return false;
        for (int i = 0; i < normalized.length(); i++) {
            if (ALPHABET.indexOf(normalized.charAt(i)) < 0) return false;
        }
        return true;
    }

    /** 生成 16 位 payload（不含前缀和连字符） */
    public String generatePayload() {
        StringBuilder sb = new StringBuilder(PAYLOAD_LEN);
        for (int i = 0; i < PAYLOAD_LEN; i++) {
            sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    /** 给用户看的格式：ZMTJ-XXXX-XXXX-XXXX-XXXX */
    public String format(String payload) {
        StringBuilder sb = new StringBuilder(PREFIX).append('-');
        for (int i = 0; i < payload.length(); i++) {
            if (i > 0 && i % 4 == 0) sb.append('-');
            sb.append(payload.charAt(i));
        }
        return sb.toString();
    }

    /** 卡密哈希（写入 DB 的值） */
    public String hash(String normalized) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(hmacKey, "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(normalized.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("HMAC 初始化失败", e);
        }
    }

    /**
     * 设备指纹（客户端上报的已经是一次性哈希，服务端原样保存）
     *
     * ★ 不要再哈希一次：token 里的 device 必须和客户端本地值严格相等，
     *   客户端才能验签后确认「这是本机的授权」。
     */
    public String deviceHash(String deviceId) {
        return deviceId == null ? "" : deviceId.trim().toLowerCase();
    }
}
