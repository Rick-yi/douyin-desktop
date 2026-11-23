package com.zmtjl.license.service;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.config.Semver;
import com.zmtjl.license.domain.AppRelease;
import com.zmtjl.license.repo.AppReleaseRepository;
import com.zmtjl.license.web.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/** 客户端版本清单：优先读已发布安装包，其次兼容旧的环境变量配置。 */
@Service
public class AppUpdateService {
    private final AppProperties props;
    private final AppReleaseRepository releaseRepo;

    public AppUpdateService(AppProperties props, AppReleaseRepository releaseRepo) {
        this.props = props;
        this.releaseRepo = releaseRepo;
    }

    public Map<String, Object> manifest(String platform, String channel, String current) {
        String p = blank(platform) ? "win" : platform.trim().toLowerCase();
        String c = blank(channel) ? "stable" : channel.trim().toLowerCase();

        Optional<AppRelease> active = releaseRepo
                .findFirstByPlatformAndChannelAndActiveTrueOrderByPublishedAtDesc(p, c);
        if (active.isPresent()) {
            return fromRelease(active.get(), current, p, c);
        }
        if (!props.isUpdateEnabled()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("enabled", false);
            return out;
        }
        if (!"win".equals(p) || !"stable".equals(c)) {
            throw new ApiException("UPDATE_PLATFORM_UNSUPPORTED", "当前平台没有更新包",
                    HttpStatus.NOT_FOUND);
        }
        return fromLegacyProperties(current);
    }

    private Map<String, Object> fromRelease(AppRelease r, String current, String platform, String channel) {
        String latest = r.getVersion();
        String min = r.getMinVersion();
        boolean hasCurrent = !blank(current) && Semver.isValid(current);
        boolean updateAvailable = !hasCurrent || Semver.compare(current, latest) < 0;
        boolean force = updateAvailable && (r.isForceUpdate()
                || (!blank(min) && (!hasCurrent || Semver.compare(current, min) < 0)));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", true);
        out.put("platform", platform);
        out.put("channel", channel);
        out.put("latestVersion", latest);
        out.put("minSupportedVersion", blank(min) ? null : min);
        out.put("currentVersion", blank(current) ? null : current);
        out.put("updateAvailable", updateAvailable);
        out.put("force", force);
        out.put("downloadUrl", downloadUrl(r.getId()));
        out.put("sha256", r.getSha256().toLowerCase());
        out.put("notes", r.getNotes());
        out.put("publishedAt", r.getPublishedAt() == null ? 0 : r.getPublishedAt());
        return out;
    }

    private Map<String, Object> fromLegacyProperties(String current) {
        String latest = props.getUpdateLatestVersion();
        String min = props.getUpdateMinVersion();
        if (blank(latest) || !Semver.isValid(latest)) {
            throw new ApiException("UPDATE_CONFIG_INVALID", "服务端未配置有效的更新版本",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }
        if (!blank(min) && !Semver.isValid(min)) {
            throw new ApiException("UPDATE_CONFIG_INVALID", "服务端最低版本配置无效",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }
        if (blank(props.getUpdateDownloadUrl()) || blank(props.getUpdateSha256())) {
            throw new ApiException("UPDATE_CONFIG_INVALID", "服务端更新下载地址或校验值未配置",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }
        boolean hasCurrent = !blank(current) && Semver.isValid(current);
        boolean updateAvailable = !hasCurrent || Semver.compare(current, latest) < 0;
        boolean force = updateAvailable
                && !blank(min) && (!hasCurrent || Semver.compare(current, min) < 0);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", true);
        out.put("platform", "win");
        out.put("channel", "stable");
        out.put("latestVersion", latest);
        out.put("minSupportedVersion", blank(min) ? null : min);
        out.put("currentVersion", blank(current) ? null : current);
        out.put("updateAvailable", updateAvailable);
        out.put("force", force);
        out.put("downloadUrl", props.getUpdateDownloadUrl());
        out.put("sha256", props.getUpdateSha256().toLowerCase());
        out.put("notes", props.getUpdateNotes());
        out.put("publishedAt", props.getUpdatePublishedAt());
        return out;
    }

    private String downloadUrl(String id) {
        String base = props.getPublicBaseUrl();
        if (base == null || base.isBlank()) base = "http://127.0.0.1:8089";
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/v1/app/download/" + id;
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
