package com.zmtjl.license.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/** 根路径进登录页；后台页面自身也会校验会话 */
@Controller
public class PageController {
    @GetMapping({"/", "/admin"})
    public String admin() {
        return "redirect:/login.html";
    }

    @GetMapping("/login")
    public String login() {
        return "redirect:/login.html";
    }
}
