package com.zmtjl.license.repo;

import com.zmtjl.license.domain.Device;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface DeviceRepository extends JpaRepository<Device, String> {
    Optional<Device> findByDeviceIdHash(String deviceIdHash);
}
