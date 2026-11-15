-- Lược đồ khởi tạo của Chat Nội Bộ.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- mã nhân viên
  display_name  TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE devices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  platform   TEXT NOT NULL CHECK (platform IN ('windows','android','ios','web','other')),
  name       TEXT NOT NULL DEFAULT '',
  trusted    INTEGER NOT NULL DEFAULT 0,               -- thiết bị do công ty cấp
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  device_id  TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_device ON sessions(device_id);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('dm','group')),
  name       TEXT NOT NULL DEFAULT '',
  dm_key     TEXT UNIQUE,                               -- "<uid nhỏ>:<uid lớn>" cho chat 1-1
  managed    INTEGER NOT NULL DEFAULT 0,                -- nhóm do công ty quản lý (admin tạo)
  allow_upload      INTEGER NOT NULL DEFAULT 0,
  allow_forward_out INTEGER NOT NULL DEFAULT 1,
  allow_copy        INTEGER NOT NULL DEFAULT 1,
  allow_save_file   INTEGER NOT NULL DEFAULT 0,         -- cho phép lưu tệp ra máy
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  last_msg_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at       INTEGER NOT NULL,
  last_read_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE files (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  uploader_id     TEXT NOT NULL REFERENCES users(id),
  r2_key          TEXT NOT NULL,
  name            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq             INTEGER NOT NULL,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('text','file','image','system')),
  text            TEXT NOT NULL DEFAULT '',
  file_id         TEXT REFERENCES files(id),
  reply_to        TEXT,
  forwarded_from  TEXT,
  client_id       TEXT,
  created_at      INTEGER NOT NULL,
  recalled_at     INTEGER,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, sender_id, client_id)
);
CREATE INDEX messages_file ON messages(file_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings(key, value) VALUES
  ('dm_upload', '0'),                    -- cấm gửi tệp trong chat 1-1
  ('members_can_create_groups', '1'),    -- nhân viên được tạo nhóm thường (không được gửi tệp)
  ('mobile_untrusted_files', 'view');    -- điện thoại cá nhân: 'allow' | 'view' (chỉ xem) | 'deny'

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
