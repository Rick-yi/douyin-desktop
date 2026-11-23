package com.zmtjl.license.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.domain.EventLog;
import com.zmtjl.license.repo.EventLogRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 管理端操作审计：记录谁在什么时候通过什么接口做了什么。
 *
 * 不记录请求体和 X-Admin-Token；查询参数里的 key/token/password 等值会被替换。
 */
@Component
public class AdminAuditInterceptor implements HandlerInterceptor {
    private static final Logger log = LoggerFactory.getLogger(AdminAuditInterceptor.class);
    private static final Set<String> SENSITIVE_QUERY = Set.of(
            "key", "token", "password", "secret", "content", "phone", "email");

    private final EventLogRepository eventRepo;
    private final ObjectMapper mapper;
    private final ClientIpResolver ipResolver;
    private final Clock clock;

    public AdminAuditInterceptor(EventLogRepository eventRepo, ObjectMapper mapper,
                                 ClientIpResolver ipResolver, Clock clock) {
        this.eventRepo = eventRepo;
        this.mapper = mapper;
        this.ipResolver = ipResolver;
        this.clock = clock;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        request.setAttribute("adminAuditStart", System.currentTimeMillis());
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        if (!needAudit(request)) return;
        try {
            long start = (long) request.getAttribute("adminAuditStart");
            Map<String, Object> meta = new LinkedHashMap<>();
            meta.put("method", request.getMethod());
            meta.put("path", request.getRequestURI());
            meta.put("query", sanitizeQuery(request.getQueryString()));
            meta.put("status", response.getStatus());
            meta.put("ip", ipResolver.resolve(request));
            meta.put("durationMs", System.currentTimeMillis() - start);
            if (ex != null) meta.put("error", ex.getClass().getSimpleName());

            EventLog event = new EventLog();
            event.setId(UUID.randomUUID().toString());
            event.setType("admin_http");
            event.setMetaJson(mapper.writeValueAsString(meta));
            event.setCreatedAt(clock.millis());
            eventRepo.save(event);
        } catch (Exception e) {
            log.warn("写管理端审计失败: {}", e.getMessage());
        }
    }

    private static boolean needAudit(HttpServletRequest req) {
        String method = req.getMethod().toUpperCase(Locale.ROOT);
        String path = req.getRequestURI();
        if (Set.of("POST", "PUT", "PATCH", "DELETE").contains(method)) return true;
        // 敏感读取也记录
        return path.endsWith("/key") || path.endsWith("/lookup")
                || path.contains("/keys/lookup");
    }

    private static String sanitizeQuery(String query) {
        if (query == null || query.isBlank()) return "";
        StringBuilder out = new StringBuilder();
        for (String part : query.split("&")) {
            if (out.length() > 0) out.append('&');
            int eq = part.indexOf('=');
            if (eq <= 0) {
                out.append(part);
                continue;
            }
            String name = part.substring(0, eq);
            if (SENSITIVE_QUERY.contains(name.toLowerCase(Locale.ROOT))) {
                out.append(name).append("=***");
            } else {
                out.append(part);
            }
        }
        if (out.length() > 500) return out.substring(0, 500);
        return out.toString();
    }
}
