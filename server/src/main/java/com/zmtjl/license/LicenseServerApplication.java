package com.zmtjl.license;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;
import com.zmtjl.license.config.AppProperties;

@SpringBootApplication
@EnableConfigurationProperties(AppProperties.class)
@EnableScheduling
public class LicenseServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(LicenseServerApplication.class, args);
    }
}
