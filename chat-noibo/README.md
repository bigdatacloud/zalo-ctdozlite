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
| Người bên ngoài | Lẫn vào bất kỳ nhóm nào | Chỉ vào được nhóm "bên ngoài" của đúng đơn vị họ, do công ty mở |
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

## Nhà cung cấp và khách hàng (tài khoản bên ngoài)

Công ty tạo tài khoản cho đối tác ở trang quản trị (loại "Bên ngoài", bắt buộc ghi tên đơn vị, có thể đặt hạn sử dụng). Sau đó tạo **nhóm có người bên ngoài** gắn với đúng đơn vị đó, ví dụ "Mua hàng - Gỗ ABC". Đối tác cài cùng ứng dụng và đăng nhập bằng tài khoản được cấp.

| Luật | Áp dụng |
|---|---|
| Người bên ngoài xem danh bạ công ty, nhắn riêng, tạo nhóm | **Cấm** |
| Nhân viên nhắn riêng cho người bên ngoài | **Cấm**: mọi trao đổi với đối tác đi qua nhóm, có người phụ trách và nhật ký |
| Đưa người bên ngoài vào nhóm nội bộ | **Cấm** |
| Một nhóm bên ngoài chứa người của hai đơn vị khác nhau | **Cấm**: NCC A không bao giờ thấy NCC B |
| Nhân viên gửi tệp vào nhóm bên ngoài (đơn hàng, bản vẽ) | **Phải được duyệt** (xem dưới). Người duyệt tự gửi thì đi thẳng, vẫn ghi nhật ký |
| Đối tác gửi tệp vào nhóm (báo giá, hóa đơn) | Được, không cần duyệt |
| Chuyển tiếp tin từ bất kỳ đâu **vào** nhóm bên ngoài | **Cấm**: muốn đưa gì ra ngoài phải chủ động gửi, có dấu vết |
| Chuyển tiếp báo giá/tài liệu của đối tác **vào** nhóm công ty | Được |
| Người bên ngoài chuyển tiếp tin | **Cấm** |
| Người bên ngoài thấy phòng ban của nhân viên | Không (ẩn) |
| Tài khoản hết hạn | Không đăng nhập được; thiết bị đang mở bị thu hồi và xóa dữ liệu trong vòng 15 phút (tác vụ định kỳ) |

Khách hàng không chịu dùng ứng dụng thì làm việc qua email như anh đã quyết, hệ thống này không cần làm gì thêm cho trường hợp đó.

### Duyệt tệp gửi ra bên ngoài

1. Nhân viên gửi tệp vào nhóm có người bên ngoài. Tệp **chưa thành tin nhắn**: đối tác không thấy dòng nào, không mở được tệp, không nhận sự kiện gì.
2. Người gửi thấy "Đang chờ duyệt, đối tác chưa nhận" ngay dưới khung chat và có thể **rút lại**.
3. Người duyệt thấy số tệp chờ trên danh sách hội thoại và khay **Xem / Từ chối / Duyệt** trong nhóm. Quản trị viên còn có mục **Duyệt tệp** trên trang quản trị (xem trước ảnh, văn bản, PDF).
4. Được duyệt: tệp hiện trong nhóm, đứng tên người gửi ban đầu. Bị từ chối: người gửi thấy lý do; đối tác vẫn không biết gì.

Người duyệt gồm quản trị viên hệ thống và nhân viên được IT **giao quyền duyệt** trong từng nhóm (trang quản trị → Nhóm → Thành viên). Có thể tắt yêu cầu duyệt riêng cho từng nhóm (ô "Duyệt tệp gửi ra"). Hai người bấm duyệt cùng lúc thì chỉ một lần có hiệu lực. Tệp bị từ chối vẫn được giữ trên R2 làm bằng chứng.

## Trang quản trị

`https://<tên-miền>/admin/`, đăng nhập bằng tài khoản quản trị viên. Các mục:
- **Duyệt tệp**: tệp chờ duyệt toàn công ty, lịch sử duyệt/từ chối.
- **Tài khoản**: tạo nhân viên hoặc đối tác, nhập hàng loạt từ Excel (dán cột mã, họ tên, phòng ban; tải về CSV mật khẩu ban đầu), đặt lại mật khẩu, khóa, gia hạn.
- **Nhóm**: tạo nhóm công ty hoặc nhóm bên ngoài, bật/tắt từng quyền (gửi tệp, chuyển tiếp ra, sao chép, lưu tệp), thêm/xóa thành viên. Danh sách chọn người chỉ hiện những người được phép vào nhóm đó.
- **Thiết bị**: xem ai đăng nhập ở đâu, đánh dấu điện thoại công ty cấp, thu hồi thiết bị.
- **Chính sách**: luật chung toàn công ty.
- **Nhật ký**: lọc theo hành động, xem riêng các thao tác bị chặn.

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

Sau đó vào `https://chat.congty.vn/admin/` để làm mọi việc còn lại.

Chạy thử trên máy: `npm run db:migrate:local && npm run dev`, rồi `node scripts/seed-demo.mjs` để có dữ liệu mẫu (đăng nhập `nv001` / `matkhau123`).

## Thông báo đẩy (Firebase)

Máy chủ vẫn là Cloudflare. Firebase chỉ chuyển thông báo tới điện thoại: Android qua dịch vụ Google, iPhone qua APNs của Apple (bắt buộc với mọi ứng dụng iPhone, Firebase chỉ là cửa trung gian). Phần gửi thông báo của Firebase miễn phí.

**Nội dung tin nhắn không bao giờ đi qua Google/Apple.** Thông báo chỉ có tên người gửi và tên nhóm ("Xưởng 1 - Sản xuất: Nguyễn Văn An đã gửi một tệp"), hoặc chỉ "Bạn có tin nhắn mới" nếu IT chọn ở trang quản trị → Chính sách. Mở thông báo thì app tự tải nội dung từ máy chủ công ty.

Ngoài tin nhắn, còn có thông báo "Tệp chờ bạn duyệt" cho người duyệt và "Tệp đã được duyệt / bị từ chối" cho người gửi. Thông báo cùng một hội thoại thay thế nhau, không xếp chồng. Windows không dùng Firebase: app đang chạy thì nháy biểu tượng trên thanh tác vụ khi có tin mới.

Cài đặt (một lần):
1. [console.firebase.google.com](https://console.firebase.google.com) → tạo dự án (không cần Google Analytics).
2. Thêm ứng dụng **Android** với package `vn.noibo.chat_noibo` và ứng dụng **iOS** với bundle `vn.noibo.chatNoibo`. Không cần tải `google-services.json` hay `GoogleService-Info.plist`. Ghi lại *Project ID*, *Sender ID*, *Web API Key* và *App ID* của từng ứng dụng.
3. **iPhone**: Apple Developer → Keys → tạo khóa APNs (.p8) → tải lên Firebase (Project settings → Cloud Messaging → Apple app configuration). Trong Xcode: Runner → Signing & Capabilities → **+ Push Notifications**.
4. Máy chủ: Project settings → Service accounts → *Generate new private key*, rồi
   `npx wrangler secret put FCM_SERVICE_ACCOUNT < khoa-tai-khoan-dich-vu.json`. Xóa tệp khóa sau khi nạp.
5. Đặt các biến kho GitHub `FCM_PROJECT_ID`, `FCM_SENDER_ID`, `FCM_API_KEY`, `FCM_APP_ID_ANDROID`, `FCM_APP_ID_IOS` (Settings → Variables) để CI build app có thông báo. Build tay thì thêm các `--dart-define` tương ứng.

Đổi `vn.noibo.*` sang tên miền công ty **trước** lần phát hành đầu tiên; sau đó không đổi được nữa. Máy Huawei đời mới không có dịch vụ Google nên sẽ không nhận được thông báo khi app đang tắt.

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

- Thông báo đẩy đã có mã nhưng chỉ chạy khi cấu hình Firebase/Apple (mục trên). Đã kiểm thử với máy chủ FCM giả lập, chưa thử trên điện thoại thật.
- Nhóm rất lớn (vài trăm người): mỗi tin gửi một thông báo cho từng thiết bị (FCM không còn gửi theo lô). Nếu thấy chậm thì chuyển sang Cloudflare Queues.
- Chưa có: gọi thoại/video, trả lời trích dẫn, cảm xúc, tìm kiếm tin nhắn, xem PDF/Office trong app (hiện chỉ xem được ảnh và văn bản; tệp loại khác chỉ mở được ở nơi có quyền lưu).
- Chưa tự gửi email thông tin đăng nhập cho đối tác: trang quản trị hiện mật khẩu một lần để IT gửi thủ công.
- **Dung lượng D1**: mỗi cơ sở dữ liệu D1 có giới hạn dung lượng (10 GB tại thời điểm viết, cần kiểm tra lại). Ước tính khoảng 0,4 KB/tin kể cả chỉ mục: 500 người × 200 tin/ngày ≈ 40 MB/ngày ≈ 14 GB/năm. Sẽ chạm giới hạn trước một năm nếu không lưu trữ tin cũ ra R2 hoặc chia DB theo năm. Phải làm trước khi vượt khoảng 70% giới hạn.
- **Không mã hóa đầu-cuối, có chủ đích**: máy chủ phải đọc được nội dung để thực thi luật, lưu nhật ký và điều tra rò rỉ. Dữ liệu được Cloudflare mã hóa khi lưu, nhưng về mặt kỹ thuật Cloudflare (một công ty Mỹ) nắm khóa. Nếu công ty thuộc diện phải lưu dữ liệu tại Việt Nam theo Nghị định 53/2022 thì Cloudflare không đáp ứng; cần pháp chế xác nhận.
- Điện thoại cá nhân vẫn chụp ảnh màn hình được bằng máy khác. Hình mờ chỉ răn đe, không ngăn chặn.
