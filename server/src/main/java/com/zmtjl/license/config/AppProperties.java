package com.zmtjl.license.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 服务配置
 *
 * 生产环境必须通过环境变量覆盖：
 *   ADMIN_TOKEN      管理接口令牌（为空则管理接口关闭）
 *   KEY_HMAC_SECRET  卡密哈希的 pepper（为空时用开发默认值并在启动日志告警）
 *   KEYS_DIR         Ed25519 密钥目录
 */
@ConfigurationProperties(prefix = "app")
public class AppProperties {
    /** 管理接口令牌；为空表示禁用管理接口 */
    private String adminToken = "";
    /** 单 IP 5 分钟内管理令牌失败次数上限，超过返回 429 */
    private int adminAuthFailLimit = 20;
    /** 卡密哈希 pepper，防止 DB 泄漏后被彩虹表反查 */
    private String keyHmacSecret = "";
    /** 授权 token 有效小时数 */
    private int tokenTtlHours = 168;
    /** Ed25519 密钥存放目录 */
    private String keysDir = "./data/keys";
    /** 单 IP 每分钟激活尝试次数 */
    private int activateRateLimitPerMinute = 10;
    /** 公开下单/卡片接口单 IP 每分钟请求上限 */
    private int publicRateLimitPerMinute = 60;
    /** 短链跳转单 IP 每分钟请求上限 */
    private int redirectRateLimitPerMinute = 120;
    /** 授权心跳单 IP 每分钟请求上限 */
    private int heartbeatRateLimitPerMinute = 240;
    /** 是否信任 X-Forwarded-For（只有前面是可信代理时才开） */
    private boolean trustForwardedFor = false;
    /** 可信代理地址，逗号分隔，支持 CIDR，如 127.0.0.1,10.0.0.0/8 */
    private String trustedProxies = "";
    /** 生产强制要求配置非 localhost 的 PUBLIC_BASE_URL */
    private boolean requirePublicUrl = false;
    /** 生产强制要求 PUBLIC_BASE_URL 为 https */
    private boolean requireHttpsPublicUrl = false;
    /** 跳转点击明细保留天数，0 表示不清理 */
    private int jumpClickRetentionDays = 90;
    /** 同一卡片同一 IP 的去重窗口（秒），0 表示不去重 */
    private int jumpClickDedupeSeconds = 60;
    /** 对外基础地址，用于拼接支付回调/收银台地址 */
    private String publicBaseUrl = "http://127.0.0.1:8089";
    /** 启用的支付渠道，逗号分隔：manual,mock,... */
    private String payChannels = "manual";
    /** mock 渠道的签名密钥；为空则 mock 渠道即使列出也不可用 */
    private String payMockSecret = "";
    /** 订单未支付自动关闭时间（分钟） */
    private int orderExpireMinutes = 30;
    /** 卡密明文在订单里的加密密钥（Base64 32 字节）；为空时从 KEY_HMAC_SECRET 派生 */
    private String dataEncKey = "";
    /** 是否启用客户端版本清单 */
    private boolean updateEnabled = false;
    /** 最新版本号，如 0.2.0 */
    private String updateLatestVersion = "";
    /** 最低支持版本；低于该版本强制更新 */
    private String updateMinVersion = "";
    /** 安装包下载地址（建议 HTTPS） */
    private String updateDownloadUrl = "";
    /** 安装包 SHA256（64 位 hex） */
    private String updateSha256 = "";
    /** 更新说明 */
    private String updateNotes = "";
    /** 发布时间（毫秒） */
    private long updatePublishedAt = 0;
    /** 安装包存放目录 */
    private String releasesDir = "./data/releases";
    /** 单个安装包最大大小（MB） */
    private int updateMaxFileMb = 300;

    public String getAdminToken() { return adminToken; }
    public void setAdminToken(String adminToken) { this.adminToken = adminToken; }
    public int getAdminAuthFailLimit() { return adminAuthFailLimit; }
    public void setAdminAuthFailLimit(int v) { this.adminAuthFailLimit = v; }
    public String getKeyHmacSecret() { return keyHmacSecret; }
    public void setKeyHmacSecret(String keyHmacSecret) { this.keyHmacSecret = keyHmacSecret; }
    public int getTokenTtlHours() { return tokenTtlHours; }
    public void setTokenTtlHours(int tokenTtlHours) { this.tokenTtlHours = tokenTtlHours; }
    public String getKeysDir() { return keysDir; }
    public void setKeysDir(String keysDir) { this.keysDir = keysDir; }
    public int getActivateRateLimitPerMinute() { return activateRateLimitPerMinute; }
    public void setActivateRateLimitPerMinute(int v) { this.activateRateLimitPerMinute = v; }
    public int getPublicRateLimitPerMinute() { return publicRateLimitPerMinute; }
    public void setPublicRateLimitPerMinute(int v) { this.publicRateLimitPerMinute = v; }
    public int getRedirectRateLimitPerMinute() { return redirectRateLimitPerMinute; }
    public void setRedirectRateLimitPerMinute(int v) { this.redirectRateLimitPerMinute = v; }
    public int getHeartbeatRateLimitPerMinute() { return heartbeatRateLimitPerMinute; }
    public void setHeartbeatRateLimitPerMinute(int v) { this.heartbeatRateLimitPerMinute = v; }
    public boolean isTrustForwardedFor() { return trustForwardedFor; }
    public void setTrustForwardedFor(boolean v) { this.trustForwardedFor = v; }
    public String getTrustedProxies() { return trustedProxies; }
    public void setTrustedProxies(String v) { this.trustedProxies = v; }
    public boolean isRequirePublicUrl() { return requirePublicUrl; }
    public void setRequirePublicUrl(boolean v) { this.requirePublicUrl = v; }
    public boolean isRequireHttpsPublicUrl() { return requireHttpsPublicUrl; }
    public void setRequireHttpsPublicUrl(boolean v) { this.requireHttpsPublicUrl = v; }
    public int getJumpClickRetentionDays() { return jumpClickRetentionDays; }
    public void setJumpClickRetentionDays(int v) { this.jumpClickRetentionDays = v; }
    public int getJumpClickDedupeSeconds() { return jumpClickDedupeSeconds; }
    public void setJumpClickDedupeSeconds(int v) { this.jumpClickDedupeSeconds = v; }
    public String getPublicBaseUrl() { return publicBaseUrl; }
    public void setPublicBaseUrl(String v) { this.publicBaseUrl = v; }
    public String getPayChannels() { return payChannels; }
    public void setPayChannels(String v) { this.payChannels = v; }
    public String getPayMockSecret() { return payMockSecret; }
    public void setPayMockSecret(String v) { this.payMockSecret = v; }
    public int getOrderExpireMinutes() { return orderExpireMinutes; }
    public void setOrderExpireMinutes(int v) { this.orderExpireMinutes = v; }
    public String getDataEncKey() { return dataEncKey; }
    public void setDataEncKey(String v) { this.dataEncKey = v; }
    public boolean isUpdateEnabled() { return updateEnabled; }
    public void setUpdateEnabled(boolean v) { this.updateEnabled = v; }
    public String getUpdateLatestVersion() { return updateLatestVersion; }
    public void setUpdateLatestVersion(String v) { this.updateLatestVersion = v; }
    public String getUpdateMinVersion() { return updateMinVersion; }
    public void setUpdateMinVersion(String v) { this.updateMinVersion = v; }
    public String getUpdateDownloadUrl() { return updateDownloadUrl; }
    public void setUpdateDownloadUrl(String v) { this.updateDownloadUrl = v; }
    public String getUpdateSha256() { return updateSha256; }
    public void setUpdateSha256(String v) { this.updateSha256 = v; }
    public String getUpdateNotes() { return updateNotes; }
    public void setUpdateNotes(String v) { this.updateNotes = v; }
    public long getUpdatePublishedAt() { return updatePublishedAt; }
    public void setUpdatePublishedAt(long v) { this.updatePublishedAt = v; }
    public String getReleasesDir() { return releasesDir; }
    public void setReleasesDir(String v) { this.releasesDir = v; }
    public int getUpdateMaxFileMb() { return updateMaxFileMb; }
    public void setUpdateMaxFileMb(int v) { this.updateMaxFileMb = v; }
}
