-- Gọi thoại 1-1 (WebRTC). Máy chủ chỉ giữ trạng thái và chuyển tín hiệu; âm thanh đi trực tiếp
-- giữa hai máy hoặc qua TURN của Cloudflare. Không ghi âm.
CREATE TABLE calls (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  caller_id       TEXT NOT NULL REFERENCES users(id),
  callee_id       TEXT NOT NULL REFERENCES users(id),
  caller_device   TEXT NOT NULL,
  callee_device   TEXT,
  state           TEXT NOT NULL CHECK (state IN ('ringing','active','ended')),
  end_reason      TEXT,
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  ended_at        INTEGER
);
CREATE INDEX calls_open_caller ON calls(caller_id, state);
CREATE INDEX calls_open_callee ON calls(callee_id, state);
INSERT INTO settings(key, value) VALUES ('calls_enabled', '1');
