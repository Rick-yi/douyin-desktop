package com.zmtjl.license.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 公开接口限流（按 IP 滑动窗口）。
 *
 * 只信任来自可信代理的 X-Forwarded-For，避免伪造 IP 绕过。
 */
@Component
public class RateLimitFilter extends OncePerRequestFilter {
    private final AppProperties props;
    private final ObjectMapper mapper;
    private final ClientIpResolver ipResolver;
    private final Map<String, Deque<Long>> windows = new ConcurrentHashMap<>();
    private final AtomicLong lastSweep = new AtomicLong();

    public RateLimitFilter(AppProperties props, ObjectMapper mapper, ClientIpResolver ipResolver) {
        this.props = props;
        this.mapper = mapper;
        this.ipResolver = ipResolver;
    }

    private Limit limitFor(HttpServletRequest request) {
        String method = request.getMethod();
        String path = request.getRequestURI();
        if ("POST".equalsIgnoreCase(method) && "/v1/license/activate".equals(path)) {
            return new Limit("activate", props.getActivateRateLimitPerMinute());
        }
        if ("POST".equalsIgnoreCase(method) && "/v1/shop/orders".equals(path)) {
            return new Limit("shop-order", props.getPublicRateLimitPerMinute());
        }
        if ("GET".equalsIgnoreCase(method) && "/v1/app/version".equals(path)) {
            return new Limit("app-version", props.getPublicRateLimitPerMinute());
        }
        if ("GET".equalsIgnoreCase(method)
                && ("/v1/jump/cards".equals(path) || path.startsWith("/v1/jump/cards/"))) {
            return new Limit("jump-card", props.getPublicRateLimitPerMinute());
        }
        if ("GET".equalsIgnoreCase(method) && path.startsWith("/r/")) {
            return new Limit("jump-redirect", props.getRedirectRateLimitPerMinute());
        }
        if ("POST".equalsIgnoreCase(method) && "/v1/license/heartbeat".equals(path)) {
            return new Limit("license-heartbeat", props.getHeartbeatRateLimitPerMinute());
        }
        return null;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        Limit limit = limitFor(request);
        return limit == null || limit.limit <= 0;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        Limit limit = limitFor(request);
        if (limit == null || limit.limit <= 0) {
            chain.doFilter(request, response);
            return;
        }

        long now = System.currentTimeMillis();
        String ip = ipResolver.resolve(request);
        String key = ip + "|" + limit.bucket;
        Deque<Long> q = windows.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (q) {
            while (!q.isEmpty() && now - q.peekFirst() > 60_000) q.pollFirst();
            if (q.size() >= limit.limit) {
                response.setStatus(429);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                response.setCharacterEncoding("UTF-8");
                response.getWriter().write(mapper.writeValueAsString(
                        Map.of("code", "RATE_LIMITED", "message", "尝试过于频繁，请一分钟后再试")));
                return;
            }
            q.addLast(now);
        }

        long last = lastSweep.get();
        if (now - last > 300_000 && lastSweep.compareAndSet(last, now)) {
            windows.entrySet().removeIf(e -> {
                Deque<Long> dq = e.getValue();
                synchronized (dq) {
                    return dq.isEmpty() || now - dq.peekLast() > 300_000;
                }
            });
        }

        chain.doFilter(request, response);
    }

    private record Limit(String bucket, int limit) {}
}
