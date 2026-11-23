package com.zmtjl.license.web;

import com.zmtjl.license.service.JumpCardService;
import com.zmtjl.license.web.JumpCardDtos.*;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** 管理端：跳转卡（Auth 由 AdminAuthInterceptor 处理） */
@RestController
@RequestMapping("/v1/admin/jump-cards")
public class AdminJumpCardController {
    private final JumpCardService service;

    public AdminJumpCardController(JumpCardService service) {
        this.service = service;
    }

    @GetMapping
    public Object list(@RequestParam(required = false) Integer page,
                       @RequestParam(required = false) Integer size) {
        return service.list(page, size);
    }

    @GetMapping("/{id}")
    public JumpCardDetail detail(@PathVariable String id) {
        return service.detail(id);
    }

    @PostMapping
    public JumpCardView create(@Valid @RequestBody JumpCardUpsertRequest req) {
        return service.create(req);
    }

    @PutMapping("/{id}")
    public JumpCardView update(@PathVariable String id, @Valid @RequestBody JumpCardUpsertRequest req) {
        return service.update(id, req);
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) {
        service.delete(id);
        return Map.of("ok", true);
    }
}
