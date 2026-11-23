package com.zmtjl.license.web;

import com.zmtjl.license.config.AppProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.file.Path;
import java.time.Duration;

@Configuration
public class WebConfig implements WebMvcConfigurer {
    private final AppProperties props;
    private final AdminAuthInterceptor adminAuthInterceptor;
    private final AdminAuditInterceptor adminAuditInterceptor;

    public WebConfig(AppProperties props,
                     AdminAuthInterceptor adminAuthInterceptor,
                     AdminAuditInterceptor adminAuditInterceptor) {
        this.props = props;
        this.adminAuthInterceptor = adminAuthInterceptor;
        this.adminAuditInterceptor = adminAuditInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(adminAuthInterceptor).addPathPatterns("/v1/admin/**");
        registry.addInterceptor(adminAuditInterceptor).addPathPatterns("/v1/admin/**");
    }

    /** 管理端上传的图片：公开读取，便于抖音/微信直接加载 */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        Path root = Path.of(props.getReleasesDir(), "uploads")
                .toAbsolutePath().normalize();
        String location = root.toUri().toString();
        if (!location.endsWith("/")) location += "/";
        registry.addResourceHandler("/uploads/**")
                .addResourceLocations(location)
                .setCacheControl(CacheControl.maxAge(Duration.ofDays(7)).cachePublic());
    }
}
