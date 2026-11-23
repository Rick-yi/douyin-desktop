-- 跳转卡支持个人微信二维码：
-- target_type = url         普通 HTTP(S) 跳转
-- target_type = wechat_qr   展示微信二维码的落地页
ALTER TABLE jump_card
  ADD COLUMN target_type VARCHAR(32) NOT NULL DEFAULT 'url';

ALTER TABLE jump_card
  ADD COLUMN qr_image_url VARCHAR(1024);
