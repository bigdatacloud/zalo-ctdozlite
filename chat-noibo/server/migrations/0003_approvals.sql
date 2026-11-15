-- Duyệt tệp gửi ra bên ngoài: tệp của nhân viên không có quyền duyệt gửi vào nhóm
-- có người bên ngoài sẽ nằm chờ, chưa thành tin nhắn, đối tác không thấy.
ALTER TABLE conversations ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0;
UPDATE conversations SET require_approval = 1 WHERE external = 1;

CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id       TEXT NOT NULL REFERENCES users(id),
  file_id         TEXT NOT NULL REFERENCES files(id),
  caption         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at      INTEGER NOT NULL,
  decided_by      TEXT REFERENCES users(id),
  decided_at      INTEGER,
  reason          TEXT NOT NULL DEFAULT '',
  message_id      TEXT
);
CREATE INDEX approvals_status ON approvals(status, created_at);
CREATE INDEX approvals_conv ON approvals(conversation_id, status);
