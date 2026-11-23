package com.zmtjl.license.web;

import org.springframework.data.domain.Page;

import java.util.List;
import java.util.function.Function;

/** 管理端分页响应；老客户端不传 page/size 时仍返回数组。 */
public record PageResponse<T>(
        List<T> content,
        int page,
        int size,
        long total,
        int totalPages
) {
    public static <E, T> PageResponse<T> of(Page<E> page, Function<E, T> mapper) {
        return new PageResponse<>(
                page.getContent().stream().map(mapper).toList(),
                page.getNumber(),
                page.getSize(),
                page.getTotalElements(),
                page.getTotalPages());
    }
}
