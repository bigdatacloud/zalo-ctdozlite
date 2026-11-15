# Chat Nội Bộ

Ứng dụng chat nội bộ thay thế Zalo trong công ty. Toàn bộ dữ liệu nằm trên tài khoản Cloudflare của công ty, mọi luật kiểm soát dữ liệu chạy ở máy chủ.

- `server/`: Cloudflare Workers + D1 (SQLite) + R2 (tệp) + Durable Objects (WebSocket thời gian thực).
- `app/`: Flutter, **một mã nguồn** cho Windows, Android, iPhone (và bản web để thử).

Bố cục, bảng màu và cách hiển thị tham khảo từ ctdozlite (`src/gui/theme.rs`). Phần giao thức Zalo không dùng lại được vì hệ thống này có máy chủ riêng.

## Vì sao khác hẳn việc “sửa client Zalo”

| | Client Zalo sửa lại | Chat Nội Bộ |
|---|---|---|
| Luật chặn nằm ở đâu | Trong app trên máy người dùng, dễ vượt | Trên máy chủ công ty, client không vượt được |
| Điện thoại | Zalo gốc vẫn chạy song song, chuyển tiếp thoải mái | Cùng một luật cho mọi thiết bị |
| Người nhận bên ngoài | Có thể có trong nhóm | Không tồn tại: chỉ tài khoản công ty cấp |
| Chặn Zalo bằng tường lửa | Không được (client dùng chung máy chủ Zalo) | Chặn toàn bộ `*.zalo.me`, `*.zaloapp.com` được |
| Nghỉ việc / mất máy | Không làm gì được | Khóa tài khoản → mọi thiết bị bị đăng xuất và xóa dữ liệu ngay |

## Luật kiểm soát dữ liệu (mặc định)

| Hành động | Chat 1-1 | Nhóm thường (nhân viên tạo) | Nhóm công ty (IT tạo) |
|---|---|---|---|
| Gửi tệp/ảnh | **Cấm** | **Cấm** | Được |
| Chuyển tiếp ra hội thoại khác | Được (chỉ chữ) | Được (chỉ chữ) | **Cấm** (IT có thể mở, nhưng chỉ sang nhóm công ty khác) |
| Sao chép chữ | Được | Được | **Cấm** |
| Lưu tệp ra máy | – | – | **Cấm** (IT bật theo từng nhóm) |
| Điện thoại cá nhân mở tệp | – | – | Chỉ xem trong app (có thể đổi thành cấm hẳn) |

Thêm vào đó:
- Chuyển tiếp tin có tệp tới nơi không được gửi tệp: **bị chặn**, để không thành đường vòng qua lệnh cấm tải lên.
- Thu hồi tin nhắn có tệp: người khác mất quyền mở tệp ngay.
- Hình mờ chéo tên + mã nhân viên + ngày trên khung chat, ảnh và tệp: ảnh chụp lén bằng điện thoại khác vẫn lộ danh tính người chụp.
- Chặn chụp màn hình: Android dùng `FLAG_SECURE`, Windows dùng `WDA_EXCLUDEFROMCAPTURE` (ảnh chụp và chia sẻ màn hình ra màu đen). iOS **không** chặn được, chỉ làm mờ khi chuyển app.
- Tin nhắn chỉ giữ trong RAM, không ghi ra đĩa máy người dùng.
- Mọi thao tác gửi tệp, mở tệp, lưu tệp, chuyển tiếp, đăng nhập (kể cả bị chặn) đều được ghi vào `audit`. Quản trị viên xem nội dung hội thoại của người khác phải ghi lý do, và lần xem đó cũng bị ghi lại.

Toàn bộ luật nằm trong `server/src/policy.ts`. Kiểm thử đầu-cuối ở `server/test/e2e.test.mjs` chạy với D1/R2/Durable Objects thật của workerd.

## Triển khai máy chủ (Cloudflare)

Cần gói **Workers Paid** để dùng Durable Objects.

```bash
cd chat-noibo/server
npm ci
npx wrangler login
npx wrangler d1 create chat_noibo --location=apac      # dán database_id vào wrangler.toml
npx wrangler r2 bucket create chat-noibo-files
npm run db:migrate:remote
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN          # chuỗi ngẫu nhiên, dùng 1 lần
npm run deploy
# gắn tên miền riêng (vd chat.congty.vn) cho Worker trong dashboard → Settings → Domains & Routes
```

Tạo quản trị viên đầu tiên (chỉ chạy được khi chưa có người dùng nào):

```bash
curl -X POST https://chat.congty.vn/api/admin/bootstrap -H 'content-type: application/json' \
  -d '{"token":"<ADMIN_BOOTSTRAP_TOKEN>","username":"admin","display_name":"Phòng IT","password":"<mật khẩu mạnh>"}'
```

Sau đó dùng API `/api/admin/*` để tạo tài khoản, nhóm công ty, đổi chính sách, xem nhật ký (xem `server/src/admin.ts`). Chưa có giao diện quản trị.

Chạy thử trên máy: `npm run db:migrate:local && npm run dev`, rồi `node scripts/seed-demo.mjs` để có dữ liệu mẫu (đăng nhập `nv001` / `matkhau123`).

## Build ứng dụng

Địa chỉ máy chủ được gắn cứng lúc build, người dùng không đổi được:

```bash
cd chat-noibo/app
flutter build windows --release --dart-define=API_BASE=https://chat.congty.vn
flutter build apk     --release --dart-define=API_BASE=https://chat.congty.vn
flutter build ipa     --release --dart-define=API_BASE=https://chat.congty.vn   # cần máy Mac + tài khoản Apple
```

CI (`.github/workflows/chat-noibo.yml`) build cả ba nền tảng khi có thay đổi trong `chat-noibo/`. Đặt biến kho `CHAT_API_BASE` để bản build trỏ đúng máy chủ.

Phát hành:
- **Windows**: đẩy qua GPO/Intune. Khóa Zalo bằng AppLocker/WDAC (chặn publisher VNG) và chặn DNS `*.zalo.me`, `*.zaloapp.com` trên tường lửa công ty.
- **Android**: APK nội bộ qua MDM hoặc link tải nội bộ. Cần tạo keystore ký bản phát hành; template hiện ký bằng khóa debug.
- **iPhone**: cần Apple Developer Program. Phát hành nội bộ qua *Custom App* trên Apple Business Manager hoặc TestFlight. Bản build mỗi đợt TestFlight hết hạn sau 90 ngày.

## Giới hạn và rủi ro đã biết

- **Chưa có thông báo đẩy** (FCM/APNs). Điện thoại chỉ nhận tin khi app đang mở. Đây là việc cần làm tiếp theo, và chỉ nên đẩy thông báo không kèm nội dung để nội dung không đi qua máy chủ Google/Apple.
- Chưa có: gọi thoại/video, trả lời trích dẫn, cảm xúc, tìm kiếm tin nhắn, xem PDF/Office trong app (hiện chỉ xem được ảnh và văn bản; tệp loại khác chỉ mở được ở nơi có quyền lưu), giao diện quản trị web.
- **Dung lượng D1**: mỗi cơ sở dữ liệu D1 có giới hạn dung lượng (10 GB tại thời điểm viết, cần kiểm tra lại). Ước tính khoảng 0,4 KB/tin kể cả chỉ mục: 500 người × 200 tin/ngày ≈ 40 MB/ngày ≈ 14 GB/năm. Sẽ chạm giới hạn trước một năm nếu không lưu trữ tin cũ ra R2 hoặc chia DB theo năm. Phải làm trước khi vượt khoảng 70% giới hạn.
- **Không mã hóa đầu-cuối, có chủ đích**: máy chủ phải đọc được nội dung để thực thi luật, lưu nhật ký và điều tra rò rỉ. Dữ liệu được Cloudflare mã hóa khi lưu, nhưng về mặt kỹ thuật Cloudflare (một công ty Mỹ) nắm khóa. Nếu công ty thuộc diện phải lưu dữ liệu tại Việt Nam theo Nghị định 53/2022 thì Cloudflare không đáp ứng; cần pháp chế xác nhận.
- Điện thoại cá nhân vẫn chụp ảnh màn hình được bằng máy khác. Hình mờ chỉ răn đe, không ngăn chặn.
