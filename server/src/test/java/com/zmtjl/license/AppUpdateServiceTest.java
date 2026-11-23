package com.zmtjl.license;

import com.zmtjl.license.config.AppProperties;
import com.zmtjl.license.domain.AppRelease;
import com.zmtjl.license.repo.AppReleaseRepository;
import com.zmtjl.license.service.AppUpdateService;
import com.zmtjl.license.web.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AppUpdateServiceTest {
    private static AppProperties props() {
        AppProperties p = new AppProperties();
        p.setUpdateEnabled(true);
        p.setUpdateLatestVersion("0.3.0");
        p.setUpdateMinVersion("0.2.0");
        p.setUpdateDownloadUrl("https://example.com/Shantuo-0.3.0.exe");
        p.setUpdateSha256("a".repeat(64));
        p.setUpdateNotes("修复与优化");
        return p;
    }

    private static AppUpdateService service(AppProperties p) {
        AppReleaseRepository repo = mock(AppReleaseRepository.class);
        when(repo.findFirstByPlatformAndChannelAndActiveTrueOrderByPublishedAtDesc(anyString(), anyString()))
                .thenReturn(Optional.empty());
        return new AppUpdateService(p, repo);
    }

    @Test
    void disabledReturnsDisabledManifest() {
        AppProperties p = new AppProperties();
        Map<String, Object> m = service(p).manifest("win", "stable", "0.1.0");
        assertThat(m).containsEntry("enabled", false);
        assertThat(m).doesNotContainKey("downloadUrl");
    }

    @Test
    void oldClientMustForceUpdate() {
        Map<String, Object> m = service(props()).manifest("win", "stable", "0.1.9");
        assertThat(m).containsEntry("updateAvailable", true);
        assertThat(m).containsEntry("force", true);
        assertThat(m).containsEntry("latestVersion", "0.3.0");
        assertThat(m).containsEntry("sha256", "a".repeat(64));
    }

    @Test
    void middleVersionUpdatesWithoutForce() {
        Map<String, Object> m = service(props()).manifest("win", "stable", "0.2.5");
        assertThat(m).containsEntry("updateAvailable", true);
        assertThat(m).containsEntry("force", false);
    }

    @Test
    void latestVersionIsUpToDate() {
        Map<String, Object> m = service(props()).manifest("win", "stable", "0.3.0");
        assertThat(m).containsEntry("updateAvailable", false);
        assertThat(m).containsEntry("force", false);
    }

    @Test
    void missingVersionIsTreatedAsOld() {
        Map<String, Object> m = service(props()).manifest("win", "stable", null);
        assertThat(m).containsEntry("updateAvailable", true);
        assertThat(m).containsEntry("force", true);
    }

    @Test
    void publishedReleaseWinsOverLegacyConfig() {
        AppProperties p = new AppProperties();
        p.setPublicBaseUrl("https://card.example.com");
        AppRelease release = new AppRelease();
        release.setId("rel-1");
        release.setPlatform("win");
        release.setChannel("stable");
        release.setVersion("0.4.0");
        release.setMinVersion("0.3.0");
        release.setSha256("b".repeat(64));
        release.setActive(true);
        release.setPublishedAt(123L);
        AppReleaseRepository repo = mock(AppReleaseRepository.class);
        when(repo.findFirstByPlatformAndChannelAndActiveTrueOrderByPublishedAtDesc("win", "stable"))
                .thenReturn(Optional.of(release));

        Map<String, Object> m = new AppUpdateService(p, repo).manifest("win", "stable", "0.1.0");
        assertThat(m).containsEntry("enabled", true);
        assertThat(m).containsEntry("latestVersion", "0.4.0");
        assertThat(m).containsEntry("force", true);
        assertThat(m).containsEntry("downloadUrl", "https://card.example.com/v1/app/download/rel-1");
    }

    @Test
    void otherPlatformIsRejected() {
        assertThatThrownBy(() -> service(props()).manifest("mac", "stable", "0.1.0"))
                .isInstanceOfSatisfying(ApiException.class, e ->
                        assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
    }
}
