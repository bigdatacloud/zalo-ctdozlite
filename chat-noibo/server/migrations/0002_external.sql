-- Tài khoản bên ngoài (nhà cung cấp, khách hàng) và nhóm có người bên ngoài.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal','external'));
ALTER TABLE users ADD COLUMN organization TEXT NOT NULL DEFAULT '';   -- tên đơn vị bên ngoài
ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sponsor_id TEXT;                          -- nhân viên phụ trách tài khoản bên ngoài
ALTER TABLE users ADD COLUMN expires_at INTEGER;                       -- hết hạn thì không đăng nhập được

ALTER TABLE conversations ADD COLUMN external INTEGER NOT NULL DEFAULT 0;     -- nhóm có người bên ngoài
ALTER TABLE conversations ADD COLUMN organization TEXT NOT NULL DEFAULT '';   -- đơn vị bên ngoài duy nhất được vào nhóm

CREATE INDEX users_kind ON users(kind, organization);
