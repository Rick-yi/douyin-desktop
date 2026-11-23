package com.zmtjl.license.repo;

import com.zmtjl.license.domain.Plan;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface PlanRepository extends JpaRepository<Plan, String> {
    Optional<Plan> findByCode(String code);

    boolean existsByCode(String code);

    List<Plan> findAllByOrderByCreatedAtAsc();
}
