// Tạo dữ liệu mẫu để thử: node scripts/seed-demo.mjs http://127.0.0.1:8787 <ADMIN_BOOTSTRAP_TOKEN>
const [base = "http://127.0.0.1:8787", bootstrap = "dev-bootstrap-token"] = process.argv.slice(2);
async function api(path, body, token, method = "POST") {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (r.status >= 400) throw new Error(`${path}: ${d.message}`);
  return d;
}
await api("/api/admin/bootstrap", { token: bootstrap, username: "admin", display_name: "Phòng IT", password: "admin-doi-ngay" });
const admin = (await api("/api/auth/login", { username: "admin", password: "admin-doi-ngay", platform: "web" })).token;
const people = [
  ["nv001", "Nguyễn Văn An", "Xưởng 1"],
  ["nv002", "Trần Thị Bình", "Xưởng 1"],
  ["nv003", "Lê Văn Cường", "Kỹ thuật"],
  ["nv004", "Phạm Thị Dung", "Kế hoạch"],
];
const ids = {};
for (const [u, n, d] of people) ids[u] = (await api("/api/admin/users", { username: u, display_name: n, department: d, password: "matkhau123" }, admin)).user_id;
await api("/api/admin/groups", { name: "Xưởng 1 - Sản xuất", member_ids: Object.values(ids) }, admin);
await api("/api/admin/groups", { name: "Kỹ thuật - Bản vẽ", member_ids: [ids.nv001, ids.nv003] }, admin);
const an = (await api("/api/auth/login", { username: "nv001", password: "matkhau123", platform: "web" })).token;
const binh = (await api("/api/auth/login", { username: "nv002", password: "matkhau123", platform: "web" })).token;
const dm = (await api("/api/conversations/dm", { user_id: ids.nv002 }, an)).conversation.id;
await api(`/api/conversations/${dm}/messages`, { text: "Chị Bình ơi, chiều nay ca 2 có tăng ca không ạ?" }, an);
await api(`/api/conversations/${dm}/messages`, { text: "Có em nhé, đến 20h." }, binh);
console.log("Xong. Đăng nhập thử: nv001 / matkhau123 (mật khẩu admin: admin-doi-ngay)");
