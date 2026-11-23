package com.zmtjl.license.config;

import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;

import java.net.URI;

/** 生产配置启动校验：避免把 localhost 回调地址带上线。 */
@Component
public class StartupValidator {
    private final AppProperties props;

    public StartupValidator(AppProperties props) {
        this.props = props;
    }

    @PostConstruct
    public void validate() {
        String base = props.getPublicBaseUrl();
        if (props.isRequirePublicUrl()) {
            if (base == null || base.isBlank() || isLocal(base)) {
                throw new IllegalStateException(
                        "生产环境必须配置 PUBLIC_BASE_URL 为外网可访问地址，不能是 localhost/127.0.0.1");
            }
        }
        if (props.isRequireHttpsPublicUrl()
                && (base == null || !base.toLowerCase().startsWith("https://"))) {
            throw new IllegalStateException("生产环境 PUBLIC_BASE_URL 必须使用 https://");
        }
        validateUpdate();
    }

    private void validateUpdate() {
        if (!props.isUpdateEnabled()) return;
        String latest = props.getUpdateLatestVersion();
        String min = props.getUpdateMinVersion();
        if (!Semver.isValid(latest)) {
            throw new IllegalStateException("UPDATE_LATEST_VERSION 必须是数字版本号，如 0.2.0");
        }
        if (min != null && !min.isBlank()) {
            if (!Semver.isValid(min)) {
                throw new IllegalStateException("UPDATE_MIN_VERSION 版本号格式错误");
            }
            if (Semver.compare(min, latest) > 0) {
                throw new IllegalStateException("UPDATE_MIN_VERSION 不能高于 UPDATE_LATEST_VERSION");
            }
        }
        String url = props.getUpdateDownloadUrl();
        if (url == null || url.isBlank() || !isHttpUrl(url)) {
            throw new IllegalStateException("UPDATE_DOWNLOAD_URL 必须是完整的 http(s) 地址");
        }
        if (props.isRequireHttpsPublicUrl() && !url.toLowerCase().startsWith("https://")) {
            throw new IllegalStateException("生产环境 UPDATE_DOWNLOAD_URL 必须使用 https://");
        }
        String sha = props.getUpdateSha256();
        if (sha == null || !sha.matches("[0-9a-fA-F]{64}")) {
            throw new IllegalStateException("UPDATE_SHA256 必须是 64 位十六进制");
        }
    }

    private static boolean isHttpUrl(String value) {
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    && uri.getHost() != null;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isLocal(String base) {
        try {
            String host = URI.create(base).getHost();
            if (host == null) return true;
            return "localhost".equalsIgnoreCase(host)
                    || "127.0.0.1".equals(host)
                    || "0.0.0.0".equals(host)
                    || "::1".equals(host);
        } catch (Exception e) {
            return true;
        }
    }
}
