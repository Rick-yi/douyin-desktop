package com.zmtjl.license.web;

import com.zmtjl.license.config.AppProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 管理端图片上传：跳转卡二维码 / 卡片封面。
 *
 * 文件落在 RELEASES_DIR/uploads/card-images，由 WebConfig 以 /uploads/** 公开读取。
 * 只接受真实图片头（PNG/JPEG/GIF/WebP），不信任扩展名；单文件上限 5MB。
 */
@RestController
@RequestMapping("/v1/admin/uploads")
public class AdminUploadController {
    private static final long MAX_BYTES = 5 * 1024 * 1024L;

    private final AppProperties props;

    public AdminUploadController(AppProperties props) {
        this.props = props;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> upload(@RequestParam("file") MultipartFile file) throws IOException {
        if (file == null || file.isEmpty()) {
            throw new ApiException("FILE_REQUIRED", "请选择图片文件", HttpStatus.BAD_REQUEST);
        }
        if (file.getSize() > MAX_BYTES) {
            throw new ApiException("FILE_TOO_LARGE", "图片不能超过 5MB", HttpStatus.BAD_REQUEST);
        }

        byte[] bytes = file.getBytes();
        String ext = detectImageExt(bytes);
        if (ext == null) {
            throw new ApiException("FILE_TYPE_INVALID", "只支持 PNG/JPG/GIF/WebP 图片",
                    HttpStatus.BAD_REQUEST);
        }

        Path root = uploadRoot();
        Files.createDirectories(root);
        String name = UUID.randomUUID().toString().replace("-", "") + "." + ext;
        Path target = root.resolve(name).normalize();
        if (!target.startsWith(root)) {
            throw new ApiException("FILE_PATH_INVALID", "文件路径无效", HttpStatus.BAD_REQUEST);
        }
        Files.write(target, bytes, StandardOpenOption.CREATE_NEW);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("url", publicBase() + "/uploads/card-images/" + name);
        out.put("name", file.getOriginalFilename() == null ? name : file.getOriginalFilename());
        out.put("size", bytes.length);
        out.put("contentType", contentType(ext));
        return out;
    }

    private Path uploadRoot() {
        return Path.of(props.getReleasesDir(), "uploads", "card-images")
                .toAbsolutePath().normalize();
    }

    private String publicBase() {
        String base = props.getPublicBaseUrl() == null ? "" : props.getPublicBaseUrl().trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base;
    }

    private static String contentType(String ext) {
        return switch (ext) {
            case "png" -> "image/png";
            case "gif" -> "image/gif";
            case "webp" -> "image/webp";
            default -> "image/jpeg";
        };
    }

    /** 只认文件头，改扩展名装不成图片。 */
    private static String detectImageExt(byte[] b) {
        if (b.length >= 8
                && (b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G'
                && (b[4] & 0xFF) == 0x0D && (b[5] & 0xFF) == 0x0A
                && (b[6] & 0xFF) == 0x1A && (b[7] & 0xFF) == 0x0A) {
            return "png";
        }
        if (b.length >= 3
                && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            return "jpg";
        }
        if (b.length >= 6
                && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8'
                && (b[4] == '7' || b[4] == '9') && b[5] == 'a') {
            return "gif";
        }
        if (b.length >= 12
                && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            return "webp";
        }
        return null;
    }
}
