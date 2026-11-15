-- Cơ sở dữ liệu riêng cho nhật ký kiểm soát: không chiếm dung lượng (10 GB/DB) và
-- không tranh luồng ghi với cơ sở dữ liệu tin nhắn.
CREATE TABLE audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,
  user_id         TEXT,
  device_id       TEXT,
  action          TEXT NOT NULL,
  conversation_id TEXT,
  target          TEXT,
  allowed         INTEGER NOT NULL,
  detail          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit(at);
CREATE INDEX audit_user ON audit(user_id, at);
CREATE INDEX audit_action ON audit(action, target, at);
