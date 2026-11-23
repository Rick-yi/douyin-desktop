package com.zmtjl.license.web;

import com.zmtjl.license.service.ShopService;
import com.zmtjl.license.web.ShopDtos.*;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/** 公开商城接口（不需要管理令牌） */
@RestController
@RequestMapping("/v1/shop")
public class ShopController {
    private final ShopService shop;

    public ShopController(ShopService shop) {
        this.shop = shop;
    }

    @GetMapping("/products")
    public List<ProductView> products() {
        return shop.listProducts();
    }

    @GetMapping("/channels")
    public List<ChannelView> channels() {
        return shop.listChannels();
    }

    @PostMapping("/orders")
    public OrderCreated create(@Valid @RequestBody CreateOrderRequest req) {
        return shop.createOrder(req.productId(), req.channel(), req.note());
    }

    /** 买家查单/取卡：必须带下单时返回的 token */
    @GetMapping("/orders/{outTradeNo}")
    public BuyerOrderView get(@PathVariable String outTradeNo,
                              @RequestParam(required = false) String token) {
        return shop.getBuyerOrder(outTradeNo, token);
    }
}
