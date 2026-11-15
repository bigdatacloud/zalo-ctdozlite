-- Thông báo đẩy qua Firebase Cloud Messaging (Android + iPhone qua APNs).
ALTER TABLE devices ADD COLUMN push_token TEXT;
CREATE INDEX devices_push ON devices(push_token);
-- Nội dung thông báo hiện trên màn hình khóa (đi qua máy chủ Google/Apple):
--   'none'   : chỉ "Bạn có tin nhắn mới"
--   'sender' : tên người gửi + tên nhóm, KHÔNG kèm nội dung tin
INSERT INTO settings(key, value) VALUES ('push_content', 'sender');
