package com.zmtjl.license.repo;

import com.zmtjl.license.domain.PaymentEvent;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PaymentEventRepository extends JpaRepository<PaymentEvent, String> {
    boolean existsByChannelAndEventId(String channel, String eventId);
}
