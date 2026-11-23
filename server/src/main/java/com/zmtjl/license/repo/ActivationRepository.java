package com.zmtjl.license.repo;

import com.zmtjl.license.domain.Activation;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ActivationRepository extends JpaRepository<Activation, String> {
    Optional<Activation> findByKeyIdAndDeviceIdHash(String keyId, String deviceIdHash);

    List<Activation> findByKeyIdOrderByActivatedAtAsc(String keyId);

    long countByKeyIdAndRevokedAtIsNull(String keyId);
}
