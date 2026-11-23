package com.zmtjl.license.repo;

import com.zmtjl.license.domain.JumpCard;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface JumpCardRepository extends JpaRepository<JumpCard, String> {
    Optional<JumpCard> findByCode(String code);

    boolean existsByCode(String code);

    List<JumpCard> findAllByOrderByCreatedAtDesc();

    Page<JumpCard> findAllByOrderByCreatedAtDesc(Pageable pageable);

    List<JumpCard> findByStatusOrderByCreatedAtDesc(String status);

    List<JumpCard> findByStatusAndGroupNameOrderByCreatedAtDesc(String status, String groupName);

    /** 原子累加点击计数，避免读改写加锁 */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update JumpCard c set c.clickCount = c.clickCount + 1, c.lastClickAt = :now where c.id = :id")
    int incrementClick(@Param("id") String id, @Param("now") long now);
}
