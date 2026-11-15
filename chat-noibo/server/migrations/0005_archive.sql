-- Lưu trữ tin nhắn cũ ra R2 để DB không chạm giới hạn dung lượng.
CREATE TABLE archives (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  min_seq         INTEGER NOT NULL,
  max_seq         INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  r2_key          TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL
);
CREATE INDEX archives_conv ON archives(conversation_id, max_seq);
CREATE INDEX messages_created ON messages(created_at);
INSERT INTO settings(key, value) VALUES
  ('archive_after_days', '180'),   -- tin chữ cũ hơn số ngày này chuyển sang R2 (vẫn xem được)
  ('audit_keep_days', '730');      -- nhật ký cũ hơn số ngày này chuyển sang R2 (tải về từ trang quản trị)
