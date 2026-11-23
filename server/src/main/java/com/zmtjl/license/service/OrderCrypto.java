package com.zmtjl.license.service;

import com.zmtjl.license.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 订单里的卡密明文加密（AES-256-GCM）
 *
 * 买家页面刷新或客服找回时需要能重新展示卡密，所以不能只存哈希。
 * 密钥来自 app.data-enc-key；未配置时从 KEY_HMAC_SECRET 派生并在启动日志告警。
 */
@Component
public class OrderCrypto {
    private static final Logger log = LoggerFactory.getLogger(OrderCrypto.class);
    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;

    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();

    public OrderCrypto(AppProperties props) {
        byte[] k = null;
        String configured = props.getDataEncKey();
        if (configured != null && !configured.isBlank()) {
            try {
                k = Base64.getDecoder().decode(configured.trim());
            } catch (IllegalArgumentException e) {
                throw new IllegalStateException("app.data-enc-key 不是合法的 Base64");
            }
        }
        if (k == null || (k.length != 16 && k.length != 24 && k.length != 32)) {
            String secret = props.getKeyHmacSecret();
            if (secret == null || secret.isBlank()) secret = "dev-only-change-me";
            k = sha256(secret);
            log.warn("未配置 app.data-enc-key，订单卡密加密密钥由 KEY_HMAC_SECRET 派生；生产环境请单独配置");
        }
        this.key = new SecretKeySpec(k, "AES");
    }

    public String encrypt(String plain) {
        try {
            byte[] iv = new byte[IV_LEN];
            random.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.getEncoder().encodeToString(out);
        } catch (Exception e) {
            throw new IllegalStateException("卡密加密失败", e);
        }
    }

    public String decrypt(String encoded) {
        try {
            byte[] all = Base64.getDecoder().decode(encoded);
            byte[] iv = new byte[IV_LEN];
            byte[] ct = new byte[all.length - IV_LEN];
            System.arraycopy(all, 0, iv, 0, IV_LEN);
            System.arraycopy(all, IV_LEN, ct, 0, ct.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("卡密解密失败（密钥可能已更换）", e);
        }
    }

    private static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
