package com.zmtjl.license.repo;

import com.zmtjl.license.domain.AppRelease;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface AppReleaseRepository extends JpaRepository<AppRelease, String> {
    Optional<AppRelease> findFirstByPlatformAndChannelAndActiveTrueOrderByPublishedAtDesc(
            String platform, String channel);

    Optional<AppRelease> findFirstByPlatformAndChannelAndActiveTrueOrderByCreatedAtDesc(
            String platform, String channel);

    Optional<AppRelease> findByPlatformAndChannelAndVersion(String platform, String channel, String version);

    List<AppRelease> findAllByOrderByCreatedAtDesc();

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update AppRelease r set r.active = false where r.platform = :platform and r.channel = :channel and r.active = true")
    int deactivateAll(@Param("platform") String platform, @Param("channel") String channel);
}
