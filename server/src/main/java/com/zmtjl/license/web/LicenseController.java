package com.zmtjl.license.web;

import com.zmtjl.license.service.LicenseService;
import com.zmtjl.license.web.LicenseDtos.ActivateRequest;
import com.zmtjl.license.web.LicenseDtos.DeactivateRequest;
import com.zmtjl.license.web.LicenseDtos.HeartbeatRequest;
import com.zmtjl.license.web.LicenseDtos.OkResponse;
import com.zmtjl.license.web.LicenseDtos.TokenResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/v1")
public class LicenseController {
    private final LicenseService service;

    public LicenseController(LicenseService service) {
        this.service = service;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("service", "license-server");
        m.put("time", System.currentTimeMillis());
        return m;
    }

    @GetMapping("/license/public-key")
    public Map<String, Object> publicKey() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("algorithm", "Ed25519");
        m.put("pem", service.publicKeyPem());
        return m;
    }

    @PostMapping("/license/activate")
    public TokenResponse activate(@Valid @RequestBody ActivateRequest req, HttpServletRequest http) {
        return service.activate(req.key(), req.deviceId(), req.appVersion(), clientIp(http));
    }

    @PostMapping("/license/heartbeat")
    public TokenResponse heartbeat(@Valid @RequestBody HeartbeatRequest req) {
        return service.heartbeat(req.token(), req.deviceId(), req.appVersion());
    }

    @PostMapping("/license/deactivate")
    public OkResponse deactivate(@Valid @RequestBody DeactivateRequest req) {
        service.deactivate(req.token(), req.deviceId());
        return new OkResponse(true);
    }

    private static String clientIp(HttpServletRequest req) {
        String xff = req.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) return xff.split(",")[0].trim();
        return req.getRemoteAddr();
    }
}
