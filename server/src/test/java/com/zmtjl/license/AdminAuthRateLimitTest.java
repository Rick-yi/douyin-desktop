package com.zmtjl.license;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.web.AdminAuthInterceptor;
import com.zmtjl.license.web.ApiException;
import com.zmtjl.license.web.ClientIpResolver;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AdminAuthRateLimitTest {
    @Test
    void blocksRepeatedBadTokensFromSameIp() {
        AppProperties props = new AppProperties();
        props.setAdminToken("correct-token");
        props.setAdminAuthFailLimit(3);
        props.setTrustForwardedFor(false);
        AdminAuthInterceptor interceptor = new AdminAuthInterceptor(
                props, new ClientIpResolver(props),
                Clock.fixed(Instant.parse("2026-10-30T09:00:00Z"), ZoneOffset.UTC));

        for (int i = 0; i < 3; i++) {
            assertThatThrownBy(() -> interceptor.preHandle(request("bad-token"),
                    new MockHttpServletResponse(), new Object()))
                    .isInstanceOfSatisfying(ApiException.class,
                            e -> assertThat(e.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED));
        }

        assertThatThrownBy(() -> interceptor.preHandle(request("bad-token"),
                new MockHttpServletResponse(), new Object()))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                    assertThat(e.getCode()).isEqualTo("TOO_MANY_ATTEMPTS");
                });
    }

    private static MockHttpServletRequest request(String token) {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/v1/admin/keys");
        req.setRemoteAddr("10.0.0.9");
        req.addHeader("X-Admin-Token", token);
        return req;
    }
}
