-- 套餐种子数据
-- features_json 由客户端解析，用于功能开关

INSERT INTO plan (id, code, name, features_json, device_limit, duration_days, created_at)
VALUES
  ('plan-standard', 'standard', '标准版',
   '["account","chat","broadcast","autoreply","logs","sensitive"]', 1, 30, 1730000000000),
  ('plan-pro', 'pro', '专业版',
   '["account","chat","broadcast","autoreply","logs","sensitive","intercept","monitor","proxy","export"]', 2, 365, 1730000000000),
  ('plan-trial', 'trial', '试用版',
   '["account","chat","broadcast","autoreply","logs","sensitive"]', 1, 7, 1730000000000);
