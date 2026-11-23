package com.zmtjl.license.web;

import com.zmtjl.license.service.AdminService;
import com.zmtjl.license.web.LicenseDtos.BatchExtendRequest;
import com.zmtjl.license.web.LicenseDtos.BatchRequest;
import com.zmtjl.license.web.LicenseDtos.ExtendRequest;
import com.zmtjl.license.web.LicenseDtos.GenerateRequest;
import com.zmtjl.license.web.LicenseDtos.GenerateResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** 管理接口：必须带 X-Admin-Token（见 AdminAuthInterceptor） */
@RestController
@RequestMapping("/v1/admin")
public class AdminController {
    private final AdminService service;

    public AdminController(AdminService service) {
        this.service = service;
    }

    @PostMapping("/keys/generate")
    public GenerateResponse generate(@Valid @RequestBody GenerateRequest req) {
        return service.generate(req.plan(), req.count(), req.durationDays(), req.batch(), req.note());
    }

    @GetMapping("/keys")
    public Object list(@RequestParam(required = false) String batch,
                       @RequestParam(required = false) Integer page,
                       @RequestParam(required = false) Integer size) {
        return service.list(batch, page, size);
    }

    @GetMapping("/keys/lookup")
    public Map<String, Object> lookup(@RequestParam String key) {
        return service.lookup(key);
    }

    @GetMapping("/keys/{id}")
    public Map<String, Object> detail(@PathVariable String id) {
        return service.lookupById(id);
    }

    @PostMapping("/keys/{id}/revoke")
    public Map<String, Object> revoke(@PathVariable String id) {
        return service.revoke(id);
    }

    @PostMapping("/keys/{id}/extend")
    public Map<String, Object> extend(@PathVariable String id, @Valid @RequestBody ExtendRequest req) {
        return service.extend(id, req.days());
    }

    @PostMapping("/keys/batch-revoke")
    public Map<String, Object> batchRevoke(@Valid @RequestBody BatchRequest req) {
        return service.batchRevoke(req.batch());
    }

    @PostMapping("/keys/batch-extend")
    public Map<String, Object> batchExtend(@Valid @RequestBody BatchExtendRequest req) {
        return service.batchExtend(req.batch(), req.days());
    }

    @GetMapping("/keys/export")
    public ResponseEntity<String> export(@RequestParam String batch) {
        List<Map<String, Object>> rows = service.exportRows(batch);
        StringBuilder csv = new StringBuilder("\uFEFF");
        csv.append("id,batch,status,planId,durationDays,createdAt,activatedAt,expireAt,activeDevices,keyHashPrefix\r\n");
        for (Map<String, Object> row : rows) {
            csv.append(csvRow(row, "id")).append(',')
                    .append(csvRow(row, "batch")).append(',')
                    .append(csvRow(row, "status")).append(',')
                    .append(csvRow(row, "planId")).append(',')
                    .append(csvRow(row, "durationDays")).append(',')
                    .append(csvRow(row, "createdAt")).append(',')
                    .append(csvRow(row, "activatedAt")).append(',')
                    .append(csvRow(row, "expireAt")).append(',')
                    .append(csvRow(row, "activeDevices")).append(',')
                    .append(csvRow(row, "keyHashPrefix")).append("\r\n");
        }
        String safe = batch.replaceAll("[^A-Za-z0-9_-]", "_");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"keys-" + safe + ".csv\"")
                .contentType(new MediaType("text", "csv", StandardCharsets.UTF_8))
                .body(csv.toString());
    }

    private static String csvRow(Map<String, Object> row, String key) {
        Object v = row.get(key);
        String s = v == null ? "" : String.valueOf(v);
        return '"' + s.replace("\"", "\"\"") + '"';
    }

    @PostMapping("/activations/{id}/revoke")
    public Map<String, Object> unbind(@PathVariable String id) {
        return service.unbind(id);
    }

    @GetMapping("/events")
    public Object events(@RequestParam(required = false) Integer page,
                         @RequestParam(required = false) Integer size) {
        return service.events(page, size);
    }
}
