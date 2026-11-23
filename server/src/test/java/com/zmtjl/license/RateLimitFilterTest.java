package com.zmtjl.license;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.web.ClientIpResolver;
import com.zmtjl.license.web.RateLimitFilter;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

class RateLimitFilterTest {
    @Test
    void limitsHeartbeatPerIpAndIgnoresSpoofedForwardedFor() throws Exception {
        AppProperties props = new AppProperties();
        props.setHeartbeatRateLimitPerMinute(1);
        props.setTrustForwardedFor(false);
        RateLimitFilter filter = new RateLimitFilter(
                props, new ObjectMapper(), new ClientIpResolver(props));

        MockHttpServletResponse first = invoke(filter, "1.2.3.4", "8.8.8.8");
        assertThat(first.getStatus()).isEqualTo(200);

        MockHttpServletResponse second = invoke(filter, "1.2.3.4", "9.9.9.9");
        assertThat(second.getStatus()).isEqualTo(429);
        assertThat(second.getContentAsString()).contains("RATE_LIMITED");
    }

    private static MockHttpServletResponse invoke(RateLimitFilter filter, String remote, String forwarded)
            throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/v1/license/heartbeat");
        req.setRemoteAddr(remote);
        req.addHeader("X-Forwarded-For", forwarded);
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(req, res, new MockFilterChain());
        return res;
    }
}
