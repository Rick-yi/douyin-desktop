package com.zmtjl.license;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.config.StartupValidator;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class StartupValidatorTest {
    @Test
    void rejectsLocalhostInProduction() {
        AppProperties props = new AppProperties();
        props.setRequirePublicUrl(true);
        props.setPublicBaseUrl("http://127.0.0.1:8089");
        assertThatThrownBy(() -> new StartupValidator(props).validate())
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsHttpWhenHttpsRequired() {
        AppProperties props = new AppProperties();
        props.setRequireHttpsPublicUrl(true);
        props.setPublicBaseUrl("http://card.example.com");
        assertThatThrownBy(() -> new StartupValidator(props).validate())
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void acceptsHttpsPublicUrl() {
        AppProperties props = new AppProperties();
        props.setRequirePublicUrl(true);
        props.setRequireHttpsPublicUrl(true);
        props.setPublicBaseUrl("https://card.example.com");
        assertThatCode(() -> new StartupValidator(props).validate()).doesNotThrowAnyException();
    }

    @Test
    void rejectsBrokenUpdateManifest() {
        AppProperties props = new AppProperties();
        props.setUpdateEnabled(true);
        props.setUpdateLatestVersion("0.2.0");
        props.setUpdateDownloadUrl("https://example.com/app.exe");
        props.setUpdateSha256("not-a-sha");
        assertThatThrownBy(() -> new StartupValidator(props).validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("UPDATE_SHA256");
    }

    @Test
    void rejectsMinVersionAboveLatest() {
        AppProperties props = new AppProperties();
        props.setUpdateEnabled(true);
        props.setUpdateLatestVersion("0.2.0");
        props.setUpdateMinVersion("0.3.0");
        props.setUpdateDownloadUrl("https://example.com/app.exe");
        props.setUpdateSha256("a".repeat(64));
        assertThatThrownBy(() -> new StartupValidator(props).validate())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("UPDATE_MIN_VERSION");
    }

    @Test
    void acceptsValidUpdateManifest() {
        AppProperties props = new AppProperties();
        props.setUpdateEnabled(true);
        props.setUpdateLatestVersion("v0.2.0");
        props.setUpdateMinVersion("0.1.0");
        props.setUpdateDownloadUrl("https://example.com/app.exe");
        props.setUpdateSha256("a".repeat(64));
        assertThatCode(() -> new StartupValidator(props).validate()).doesNotThrowAnyException();
    }
}
