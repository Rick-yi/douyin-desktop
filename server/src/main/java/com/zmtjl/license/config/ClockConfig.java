package com.zmtjl.license.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Clock;

@Configuration
public class ClockConfig {
    /** 统一时钟，测试里可以替换成固定时间 */
    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}
