package com.zmtjl.license.repo;

import com.zmtjl.license.domain.ShopOrder;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ShopOrderRepository extends JpaRepository<ShopOrder, String> {
    Optional<ShopOrder> findByOutTradeNo(String outTradeNo);

    /** 支付回调并发时串行化同一订单 */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from ShopOrder o where o.outTradeNo = :no")
    Optional<ShopOrder> findForUpdate(@Param("no") String outTradeNo);

    @Modifying
    @Query("update ShopOrder o set o.status = 'closed', o.closedAt = :now " +
           "where o.status = 'created' and o.expiresAt < :now")
    int closeExpired(@Param("now") long now);

    List<ShopOrder> findTop100ByOrderByCreatedAtDesc();

    List<ShopOrder> findTop100ByStatusOrderByCreatedAtDesc(String status);

    Page<ShopOrder> findAllByOrderByCreatedAtDesc(Pageable pageable);

    Page<ShopOrder> findByStatusOrderByCreatedAtDesc(String status, Pageable pageable);
}
