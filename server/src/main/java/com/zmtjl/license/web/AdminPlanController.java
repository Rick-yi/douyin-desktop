package com.zmtjl.license.web;

import com.zmtjl.license.service.PlanService;
import com.zmtjl.license.web.AdminPlanDtos.PlanUpsertRequest;
import com.zmtjl.license.web.AdminPlanDtos.PlanView;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/admin/plans")
public class AdminPlanController {
    private final PlanService service;

    public AdminPlanController(PlanService service) {
        this.service = service;
    }

    @GetMapping
    public List<PlanView> list() {
        return service.list();
    }

    @PostMapping
    public PlanView create(@Valid @RequestBody PlanUpsertRequest req) {
        return service.create(req);
    }

    @PutMapping("/{id}")
    public PlanView update(@PathVariable String id, @Valid @RequestBody PlanUpsertRequest req) {
        return service.update(id, req);
    }
}
