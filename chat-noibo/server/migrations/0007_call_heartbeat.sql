-- Nhịp "còn sống" của hai đầu cuộc gọi: máy tắt đột ngột/mất mạng thì cuộc gọi tự kết thúc,
-- không để người đó bị coi là "đang bận" hàng giờ.
ALTER TABLE calls ADD COLUMN caller_seen INTEGER;
ALTER TABLE calls ADD COLUMN callee_seen INTEGER;
