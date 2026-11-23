package com.zmtjl.license.repo;

import com.zmtjl.license.domain.JumpClick;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface JumpClickRepository extends JpaRepository<JumpClick, String> {
    List<JumpClick> findTop100ByCardIdOrderByClickedAtDesc(String cardId);

    long countByCardId(String cardId);

    void deleteByCardId(String cardId);

    boolean existsByCardIdAndIpAndClickedAtAfter(String cardId, String ip, long since);

    long deleteByClickedAtBefore(long cutoff);
}
