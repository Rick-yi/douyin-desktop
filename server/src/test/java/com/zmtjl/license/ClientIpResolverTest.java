package com.zmtjl.license;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.web.ClientIpResolver;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class ClientIpResolverTest {
    @Test
    void ignoresForwardedForByDefault() {
        AppProperties props = new AppProperties();
        props.setTrustForwardedFor(false);
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("127.0.0.1");
        req.addHeader("X-Forwarded-For", "8.8.8.8");
        assertThat(new ClientIpResolver(props).resolve(req)).isEqualTo("127.0.0.1");
    }

    @Test
    void trustsForwardedForOnlyFromTrustedProxy() {
        AppProperties props = new AppProperties();
        props.setTrustForwardedFor(true);
        props.setTrustedProxies("127.0.0.1");
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("127.0.0.1");
        req.addHeader("X-Forwarded-For", "8.8.8.8, 10.0.0.1");
        assertThat(new ClientIpResolver(props).resolve(req)).isEqualTo("8.8.8.8");
    }

    @Test
    void ignoresForwardedForFromUntrustedProxy() {
        AppProperties props = new AppProperties();
        props.setTrustForwardedFor(true);
        props.setTrustedProxies("10.0.0.0/8");
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("127.0.0.1");
        req.addHeader("X-Forwarded-For", "8.8.8.8");
        assertThat(new ClientIpResolver(props).resolve(req)).isEqualTo("127.0.0.1");
    }

    @Test
    void supportsCidr() {
        AppProperties props = new AppProperties();
        props.setTrustForwardedFor(true);
        props.setTrustedProxies("10.0.0.0/8");
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("10.1.2.3");
        req.addHeader("X-Forwarded-For", "8.8.8.8");
        assertThat(new ClientIpResolver(props).resolve(req)).isEqualTo("8.8.8.8");
    }
}
