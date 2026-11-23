package com.zmtjl.license.service;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.config.Semver;
import com.zmtjl.license.domain.AppRelease;
import com.zmtjl.license.repo.AppReleaseRepository;
import com.zmtjl.license.web.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class AppReleaseService {
    private static final Set<String> ALLOWED_EXT = Set.of(".exe", ".msi", ".zip");
    private static final int MAX_NOTES = 4000;

    private final AppReleaseRepository repo;
    private final AppProperties props;
    private final Clock clock;

    public AppReleaseService(AppReleaseRepository repo, AppProperties props, Clock clock) {
        this.repo = repo;
        this.props = props;
        this.clock = clock;
    }

    public List<Map<String, Object>> list() {
        return repo.findAllByOrderByCreatedAtDesc().stream().map(this::view).toList();
    }

    @Transactional
    public Map<String, Object> create(MultipartFile file,
                                      String version,
                                      String minVersion,
                                      boolean force,
                                      String notes,
                                      String platform,
                                      String channel,
                                      boolean publish) {
        String p = normalize(platform, "win");
        String c = normalize(channel, "stable");
        String v = version == null ? "" : version.trim();
        if (!Semver.isValid(v)) {
            throw new ApiException("VERSION_INVALID", "版本号格式错误，如 0.2.0");
        }
        String min = minVersion == null || minVersion.isBlank() ? null : minVersion.trim();
        if (min != null) {
            if (!Semver.isValid(min)) throw new ApiException("MIN_VERSION_INVALID", "最低版本格式错误");
            if (Semver.compare(min, v) > 0) {
                throw new ApiException("MIN_VERSION_INVALID", "最低版本不能高于当前版本");
            }
        }
        if (force && min == null) min = v;
        if (repo.findByPlatformAndChannelAndVersion(p, c, v).isPresent()) {
            throw new ApiException("RELEASE_EXISTS", "该版本已经存在");
        }
        if (file == null || file.isEmpty()) {
            throw new ApiException("FILE_REQUIRED", "请选择安装包");
        }
        long maxBytes = Math.max(1, props.getUpdateMaxFileMb()) * 1024L * 1024L;
        if (file.getSize() > maxBytes) {
            throw new ApiException("FILE_TOO_LARGE", "安装包超过 " + props.getUpdateMaxFileMb() + "MB");
        }
        String original = safeOriginalName(file.getOriginalFilename());
        String ext = extension(original);
        if (!ALLOWED_EXT.contains(ext)) {
            throw new ApiException("FILE_TYPE_INVALID", "只支持 .exe / .msi / .zip");
        }

        Path root = releasesRoot();
        String stored = p + "-" + c + "-" + v + "-" + clock.millis() + "-"
                + UUID.randomUUID().toString().substring(0, 8) + ext;
        Path target = root.resolve(stored).normalize();
        if (!target.startsWith(root)) {
            throw new ApiException("FILE_INVALID", "文件名非法");
        }
        Path temp = root.resolve(stored + ".part");
        long size;
        String sha256;
        try {
            Files.createDirectories(root);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            size = 0;
            try (InputStream in = file.getInputStream();
                 OutputStream out = Files.newOutputStream(temp)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    if (n == 0) continue;
                    size += n;
                    if (size > maxBytes) {
                        throw new ApiException("FILE_TOO_LARGE",
                                "安装包超过 " + props.getUpdateMaxFileMb() + "MB");
                    }
                    digest.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
            }
            sha256 = HexFormat.of().formatHex(digest.digest());
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
        } catch (ApiException e) {
            deleteQuietly(temp);
            throw e;
        } catch (Exception e) {
            deleteQuietly(temp);
            throw new ApiException("FILE_SAVE_FAILED", "安装包保存失败: " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        }

        AppRelease release = new AppRelease();
        release.setId(UUID.randomUUID().toString());
        release.setPlatform(p);
        release.setChannel(c);
        release.setVersion(v);
        release.setMinVersion(min);
        release.setForceUpdate(force);
        release.setNotes(notes == null ? null : notes.trim().substring(0, Math.min(MAX_NOTES, notes.trim().length())));
        release.setFileName(original);
        release.setStoredName(stored);
        release.setFileSize(size);
        release.setSha256(sha256);
        release.setActive(false);
        release.setCreatedAt(clock.millis());
        try {
            repo.save(release);
            if (publish) {
                activate(release);
            }
        } catch (RuntimeException e) {
            deleteQuietly(target);
            throw e;
        }
        return view(release);
    }

    @Transactional
    public Map<String, Object> publish(String id) {
        AppRelease release = require(id);
        activate(release);
        return view(release);
    }

    @Transactional
    public Map<String, Object> unpublish(String id) {
        AppRelease release = require(id);
        release.setActive(false);
        repo.save(release);
        return view(release);
    }

    @Transactional
    public Map<String, Object> delete(String id) {
        AppRelease release = require(id);
        if (release.isActive()) {
            throw new ApiException("RELEASE_ACTIVE", "启用中的版本不能删除，请先停用");
        }
        Path file = releasesRoot().resolve(release.getStoredName()).normalize();
        repo.delete(release);
        if (file.startsWith(releasesRoot())) deleteQuietly(file);
        return Map.of("ok", true, "id", id);
    }

    /** 公开下载：只允许已发布版本 */
    public Path publicFile(String id) {
        AppRelease release = repo.findById(id)
                .filter(AppRelease::isActive)
                .orElseThrow(() -> new ApiException("RELEASE_NOT_FOUND", "版本不存在或未发布",
                        HttpStatus.NOT_FOUND));
        Path root = releasesRoot();
        Path file = root.resolve(release.getStoredName()).normalize();
        if (!file.startsWith(root) || !Files.isRegularFile(file)) {
            throw new ApiException("RELEASE_FILE_MISSING", "安装包文件不存在",
                    HttpStatus.NOT_FOUND);
        }
        return file;
    }

    public AppRelease publicRelease(String id) {
        return repo.findById(id).filter(AppRelease::isActive).orElse(null);
    }

    private void activate(AppRelease release) {
        repo.deactivateAll(release.getPlatform(), release.getChannel());
        release.setActive(true);
        release.setPublishedAt(clock.millis());
        repo.save(release);
    }

    private AppRelease require(String id) {
        return repo.findById(id)
                .orElseThrow(() -> new ApiException("RELEASE_NOT_FOUND", "版本不存在",
                        HttpStatus.NOT_FOUND));
    }

    private Path releasesRoot() {
        return Path.of(props.getReleasesDir()).toAbsolutePath().normalize();
    }

    private Map<String, Object> view(AppRelease r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.getId());
        m.put("platform", r.getPlatform());
        m.put("channel", r.getChannel());
        m.put("version", r.getVersion());
        m.put("minVersion", r.getMinVersion());
        m.put("forceUpdate", r.isForceUpdate());
        m.put("notes", r.getNotes());
        m.put("fileName", r.getFileName());
        m.put("fileSize", r.getFileSize());
        m.put("sha256", r.getSha256());
        m.put("active", r.isActive());
        m.put("createdAt", r.getCreatedAt());
        m.put("publishedAt", r.getPublishedAt());
        m.put("downloadUrl", publicBase() + "/v1/app/download/" + r.getId());
        return m;
    }

    private String publicBase() {
        String base = props.getPublicBaseUrl();
        if (base == null || base.isBlank()) base = "http://127.0.0.1:8089";
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static String normalize(String value, String fallback) {
        String v = value == null || value.isBlank() ? fallback : value.trim().toLowerCase(Locale.ROOT);
        return v;
    }

    private static String safeOriginalName(String raw) {
        String name = raw == null ? "installer.exe" : raw;
        name = name.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\r\\n\\t]", "").trim();
        if (name.isEmpty()) name = "installer.exe";
        return name.length() > 200 ? name.substring(name.length() - 200) : name;
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase(Locale.ROOT);
    }

    private static void deleteQuietly(Path path) {
        try { Files.deleteIfExists(path); } catch (Exception ignored) {}
    }
}
