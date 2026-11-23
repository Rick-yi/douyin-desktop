package com.zmtjl.license.repo;

import com.zmtjl.license.domain.EventLog;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface EventLogRepository extends JpaRepository<EventLog, String> {
    List<EventLog> findTop100ByOrderByCreatedAtDesc();

    Page<EventLog> findAllByOrderByCreatedAtDesc(Pageable pageable);
}
