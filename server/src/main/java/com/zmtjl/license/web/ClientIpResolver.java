package com.zmtjl.license.web;

import com.zmtjl.license.config.AppProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

/**
 * 客户端 IP 解析。
 *
 * 只有 remoteAddr 命中 trusted-proxies 时才信任 X-Forwarded-For，
 * 否则攻击者可以伪造 XFF 绕过限流和污染审计。
 */
@Component
public class ClientIpResolver {
    private final AppProperties props;
    private final List<Cidr> trusted = new ArrayList<>();

    public ClientIpResolver(AppProperties props) {
        this.props = props;
        String raw = props.getTrustedProxies();
        if ((raw == null || raw.isBlank()) && props.isTrustForwardedFor()) {
            raw = "127.0.0.1,::1";
        }
        if (raw != null) {
            for (String part : raw.split(",")) {
                String s = part.trim();
                if (!s.isEmpty()) {
                    Cidr c = Cidr.parse(s);
                    if (c != null) trusted.add(c);
                }
            }
        }
    }

    public String resolve(HttpServletRequest req) {
        String remote = req.getRemoteAddr();
        if (!props.isTrustForwardedFor() || trusted.isEmpty()) return remote;
        InetAddress remoteAddr = parseIp(remote);
        if (remoteAddr == null || trusted.stream().noneMatch(c -> c.contains(remoteAddr))) {
            return remote;
        }
        String xff = req.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            String first = xff.split(",")[0].trim();
            if (parseIp(first) != null) return first;
        }
        String real = req.getHeader("X-Real-IP");
        if (real != null && !real.isBlank() && parseIp(real.trim()) != null) {
            return real.trim();
        }
        return remote;
    }

    private static InetAddress parseIp(String value) {
        if (value == null || value.isBlank()) return null;
        String s = value.trim();
        // 只接受 IP 字面量，避免触发 DNS 解析
        if (!s.matches("[0-9a-fA-F:.%]+") || (!s.contains(".") && !s.contains(":"))) return null;
        try {
            return InetAddress.getByName(s);
        } catch (Exception e) {
            return null;
        }
    }

    private record Cidr(byte[] network, int prefix) {
        static Cidr parse(String raw) {
            try {
                String[] parts = raw.split("/", 2);
                InetAddress addr = parseIp(parts[0]);
                if (addr == null) return null;
                int max = addr.getAddress().length * 8;
                int prefix = parts.length == 2 ? Integer.parseInt(parts[1]) : max;
                if (prefix < 0 || prefix > max) return null;
                return new Cidr(addr.getAddress(), prefix);
            } catch (Exception e) {
                return null;
            }
        }

        boolean contains(InetAddress addr) {
            byte[] other = addr.getAddress();
            if (other.length != network.length) return false;
            int full = prefix / 8;
            int rem = prefix % 8;
            for (int i = 0; i < full; i++) {
                if (network[i] != other[i]) return false;
            }
            if (rem == 0) return true;
            int mask = 0xff << (8 - rem);
            return (network[full] & mask) == (other[full] & mask);
        }
    }
}
