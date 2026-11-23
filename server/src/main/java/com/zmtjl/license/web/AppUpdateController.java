package com.zmtjl.license.web;

import com.zmtjl.license.domain.AppRelease;
import com.zmtjl.license.service.AppReleaseService;
import com.zmtjl.license.service.AppUpdateService;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

@RestController
@RequestMapping("/v1/app")
public class AppUpdateController {
    private final AppUpdateService service;
    private final AppReleaseService releaseService;

    public AppUpdateController(AppUpdateService service, AppReleaseService releaseService) {
        this.service = service;
        this.releaseService = releaseService;
    }

    @GetMapping("/version")
    public ResponseEntity<Map<String, Object>> version(
            @RequestParam(required = false) String platform,
            @RequestParam(required = false) String channel,
            @RequestParam(required = false) String current) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofSeconds(60)).cachePublic())
                .body(service.manifest(platform, channel, current));
    }

    @GetMapping("/download/{id}")
    public ResponseEntity<Resource> download(@PathVariable String id) throws Exception {
        AppRelease release = releaseService.publicRelease(id);
        Path file = releaseService.publicFile(id);
        String fileName = release == null || release.getFileName() == null
                ? "Shantuo-installer.exe" : release.getFileName();
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(Files.size(file))
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(fileName, StandardCharsets.UTF_8)
                                .build().toString())
                .body(new FileSystemResource(file));
    }
}
