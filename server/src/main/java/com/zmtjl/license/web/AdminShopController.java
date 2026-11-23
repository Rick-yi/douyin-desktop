package com.zmtjl.license.web;

import com.zmtjl.license.service.ShopService;
import com.zmtjl.license.web.ShopDtos.*;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** 管理端：商品与订单（Auth 由 AdminAuthInterceptor 处理） */
@RestController
@RequestMapping("/v1/admin")
public class AdminShopController {
    private final ShopService shop;

    public AdminShopController(ShopService shop) {
        this.shop = shop;
    }

    // ── 商品 ──

    @GetMapping("/products")
    public List<ProductView> products() {
        return shop.adminProducts();
    }

    @PostMapping("/products")
    public ProductView createProduct(@Valid @RequestBody ProductUpsertRequest req) {
        return shop.upsertProduct(null, req);
    }

    @PutMapping("/products/{id}")
    public ProductView updateProduct(@PathVariable String id, @Valid @RequestBody ProductUpsertRequest req) {
        return shop.upsertProduct(id, req);
    }

    // ── 订单 ──

    @GetMapping("/orders")
    public Object orders(@RequestParam(required = false) String status,
                         @RequestParam(required = false) Integer page,
                         @RequestParam(required = false) Integer size) {
        return shop.adminList(status, page, size);
    }

    @GetMapping("/orders/{outTradeNo}")
    public AdminOrderView order(@PathVariable String outTradeNo) {
        return shop.adminDetail(outTradeNo);
    }

    /** 客服找回卡密（返回明文，仅管理端） */
    @GetMapping("/orders/{outTradeNo}/key")
    public Map<String, Object> revealKey(@PathVariable String outTradeNo) {
        return Map.of("outTradeNo", outTradeNo, "key", shop.adminRevealKey(outTradeNo));
    }

    @PostMapping("/orders/{outTradeNo}/mark-paid")
    public AdminOrderView markPaid(@PathVariable String outTradeNo,
                                   @RequestBody(required = false) MarkPaidRequest req) {
        return shop.adminMarkPaid(outTradeNo, req == null ? null : req.transactionId());
    }

    @PostMapping("/orders/{outTradeNo}/cancel")
    public AdminOrderView cancel(@PathVariable String outTradeNo) {
        return shop.adminCancel(outTradeNo);
    }

    @PostMapping("/orders/{outTradeNo}/refund")
    public RefundResult refund(@PathVariable String outTradeNo) {
        return shop.adminRefund(outTradeNo);
    }
}
