package com.zmtjl.license.repo;

import com.zmtjl.license.domain.LicenseKey;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface LicenseKeyRepository extends JpaRepository<LicenseKey, String> {
    Optional<LicenseKey> findByKeyHash(String keyHash);

    List<LicenseKey> findByBatchIdOrderByCreatedAtAsc(String batchId);

    List<LicenseKey> findTop200ByOrderByCreatedAtDesc();

    Page<LicenseKey> findAllByOrderByCreatedAtDesc(Pageable pageable);

    Page<LicenseKey> findByBatchIdOrderByCreatedAtAsc(String batchId, Pageable pageable);
}
