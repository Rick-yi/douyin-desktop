package com.zmtjl.license.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/** 上传图片的响应头：禁止浏览器把图片当 HTML 嗅探执行 */
@Component
public class UploadHeadersFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        if (req.getRequestURI().startsWith("/uploads/")) {
            res.setHeader("X-Content-Type-Options", "nosniff");
        }
        chain.doFilter(req, res);
    }
}
