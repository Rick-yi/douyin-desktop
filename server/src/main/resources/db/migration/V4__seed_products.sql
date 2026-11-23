-- 商品种子（价格是占位值，后台或 SQL 里自行调整）
INSERT INTO product (id, code, name, plan_code, price_cents, duration_days, status, created_at)
VALUES
  ('prod-standard-30d', 'standard-30d', '标准版 · 30 天', 'standard', 9900, NULL, 'active', 1730000000000),
  ('prod-pro-1y', 'pro-1y', '专业版 · 365 天', 'pro', 29900, NULL, 'active', 1730000000000);
