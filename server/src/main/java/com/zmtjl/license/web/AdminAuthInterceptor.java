package com.zmtjl.license.web;

import com.zmtjl.license.config.AppProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** 管理接口鉴权：X-Admin-Token；未配置令牌则整体禁用 */
@Component
public class AdminAuthInterceptor implements HandlerInterceptor {
    private static final long FAIL_WINDOW_MS = 5 * 60_000L;

    private final AppProperties props;
    private final ClientIpResolver ipResolver;
    private final Clock clock;
    private final Map<String, Deque<Long>> failures = new ConcurrentHashMap<>();

    public AdminAuthInterceptor(AppProperties props, ClientIpResolver ipResolver, Clock clock) {
        this.props = props;
        this.ipResolver = ipResolver;
        this.clock = clock;
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        String expected = props.getAdminToken();
        if (expected == null || expected.isBlank()) {
            throw new ApiException("ADMIN_DISABLED", "管理接口未启用（未配置 ADMIN_TOKEN）",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }

        String ip = ipResolver.resolve(req);
        long now = clock.millis();
        if (tooManyFailures(ip, now)) {
            throw new ApiException("TOO_MANY_ATTEMPTS", "尝试过于频繁，请 5 分钟后再试",
                    HttpStatus.TOO_MANY_REQUESTS);
        }

        String actual = req.getHeader("X-Admin-Token");
        if (actual == null || !MessageDigest.isEqual(
                actual.getBytes(StandardCharsets.UTF_8),
                expected.getBytes(StandardCharsets.UTF_8))) {
            recordFailure(ip, now);
            throw new ApiException("UNAUTHORIZED", "管理令牌无效", HttpStatus.UNAUTHORIZED);
        }
        failures.remove(ip);
        return true;
    }

    private boolean tooManyFailures(String ip, long now) {
        int limit = props.getAdminAuthFailLimit();
        if (limit <= 0) return false;
        Deque<Long> q = failures.get(ip);
        if (q == null) return false;
        synchronized (q) {
            prune(q, now);
            return q.size() >= limit;
        }
    }

    private void recordFailure(String ip, long now) {
        int limit = props.getAdminAuthFailLimit();
        if (limit <= 0) return;
        Deque<Long> q = failures.computeIfAbsent(ip, k -> new ArrayDeque<>());
        synchronized (q) {
            prune(q, now);
            q.addLast(now);
        }
    }

    private static void prune(Deque<Long> q, long now) {
        while (!q.isEmpty() && now - q.peekFirst() > FAIL_WINDOW_MS) q.pollFirst();
    }
}
