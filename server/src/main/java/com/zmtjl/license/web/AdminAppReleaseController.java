package com.zmtjl.license.web;

import com.zmtjl.license.service.AppReleaseService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/v1/admin/app/releases")
public class AdminAppReleaseController {
    private final AppReleaseService service;

    public AdminAppReleaseController(AppReleaseService service) {
        this.service = service;
    }

    @GetMapping
    public List<Map<String, Object>> list() {
        return service.list();
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> create(
            @RequestPart("file") MultipartFile file,
            @RequestParam String version,
            @RequestParam(required = false) String minVersion,
            @RequestParam(defaultValue = "false") boolean force,
            @RequestParam(required = false) String notes,
            @RequestParam(defaultValue = "win") String platform,
            @RequestParam(defaultValue = "stable") String channel,
            @RequestParam(defaultValue = "true") boolean publish) {
        return service.create(file, version, minVersion, force, notes, platform, channel, publish);
    }

    @PostMapping("/{id}/publish")
    public Map<String, Object> publish(@PathVariable String id) {
        return service.publish(id);
    }

    @PostMapping("/{id}/unpublish")
    public Map<String, Object> unpublish(@PathVariable String id) {
        return service.unpublish(id);
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) {
        return service.delete(id);
    }
}
