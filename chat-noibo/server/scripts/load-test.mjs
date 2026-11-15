// Kịch bản thử tải: tạo người dùng giả, mở WebSocket cho từng người, gửi tin vào các nhóm
// với tốc độ cho trước, đo độ trễ gửi và độ trễ tới máy người nhận.
//
// CHỈ chạy trên môi trường thử nghiệm (staging), KHÔNG chạy trên hệ thống thật: kịch bản tạo
// hàng trăm tài khoản và nhóm giả.
//
//   node scripts/load-test.mjs --base https://chat-staging.congty.vn --admin admin --admin-pass '...' \
//        --users 1000 --groups 40 --group-size 50 --rate 30 --duration 120
//
// Kết quả cần xem: độ trễ p95 của "gửi" và "tới người nhận" khi tăng dần --rate; tỉ lệ lỗi;
// tỉ lệ tin đến đủ người nhận. Tăng --rate cho tới khi p95 vọt lên: đó là trần thật của D1.

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:8787");
const ADMIN = arg("admin", "admin");
const ADMIN_PASS = arg("admin-pass", "admin-doi-ngay");
const USERS = Number(arg("users", 100));
const GROUPS = Number(arg("groups", 5));
const GROUP_SIZE = Number(arg("group-size", 30));
const RATE = Number(arg("rate", 10)); // tin/giây toàn hệ thống
const DURATION = Number(arg("duration", 30)); // giây
const READ_RATIO = Number(arg("read-ratio", 0.2)); // tỉ lệ người nhận đang mở nhóm (gửi "đã đọc")
const PREFIX = arg("prefix", "lt");
const PASS = "taitai-123456";

async function api(path, { token, method = "GET", body } = {}) {
  const t0 = performance.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, ms: performance.now() - t0 };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (arr) => `p50 ${pct(arr, 50).toFixed(0)} ms · p95 ${pct(arr, 95).toFixed(0)} ms · p99 ${pct(arr, 99).toFixed(0)} ms (n=${arr.length})`;

console.log(`Thử tải ${BASE}: ${USERS} người, ${GROUPS} nhóm × ${GROUP_SIZE}, ${RATE} tin/giây trong ${DURATION} giây`);
const admin = (await api("/api/auth/login", { method: "POST", body: { username: ADMIN, password: ADMIN_PASS, platform: "web" } })).data.token;
if (!admin) throw new Error("Không đăng nhập được quản trị viên");

// 1. Người dùng (tạo lại thì bỏ qua lỗi trùng)
console.log("Tạo tài khoản…");
const existing = new Map((await api("/api/admin/users", { token: admin })).data.users.map((u) => [u.username, u.id]));
const names = Array.from({ length: USERS }, (_, i) => `${PREFIX}${String(i).padStart(5, "0")}`);
const ids = await pool(names, 8, async (u) => {
  if (existing.has(u)) return existing.get(u);
  const r = await api("/api/admin/users", { token: admin, method: "POST", body: { username: u, display_name: `Thử tải ${u}`, department: "Thử tải", password: PASS } });
  return r.data.user_id;
});

// 2. Nhóm công ty với thành viên ngẫu nhiên
console.log("Tạo nhóm…");
const groups = [];
for (let g = 0; g < GROUPS; g++) {
  const members = new Set();
  while (members.size < Math.min(GROUP_SIZE, USERS)) members.add(Math.floor(Math.random() * USERS));
  const r = await api("/api/admin/groups", { token: admin, method: "POST", body: { name: `${PREFIX} nhóm ${g}`, member_ids: [...members].map((i) => ids[i]) } });
  groups.push({ id: r.data.conversation_id, members: [...members] });
}
const groupsOf = Array.from({ length: USERS }, () => []);
groups.forEach((g, gi) => g.members.forEach((u) => groupsOf[u].push(gi)));

// 3. Đăng nhập + WebSocket
console.log("Đăng nhập và mở WebSocket…");
const tokens = await pool(names, 16, async (u) => (await api("/api/auth/login", { method: "POST", body: { username: u, password: PASS, platform: "web" } })).data.token);
const delivery = [];
const expected = new Map(); // message id -> số người nhận còn chờ
let wsErrors = 0;
let delivered = 0;
const sockets = await pool(tokens, 50, (tok, ui) =>
  new Promise((res) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws?token=${tok}`);
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      const ev = JSON.parse(e.data);
      if (ev.type === "hello") return res(ws);
      if (ev.type !== "message" || !ev.message.text.startsWith("lt:")) return;
      if (ev.message.sender_id === ids[ui]) return;
      delivery.push(Date.now() - Number(ev.message.text.slice(3)));
      delivered++;
      const left = (expected.get(ev.message.id) ?? 1) - 1;
      left <= 0 ? expected.delete(ev.message.id) : expected.set(ev.message.id, left);
      if (Math.random() < READ_RATIO) api(`/api/conversations/${ev.message.conversation_id}/read`, { token: tok, method: "POST", body: { seq: ev.message.seq } });
    };
    ws.onerror = () => {
      wsErrors++;
      res(null);
    };
  }),
);
console.log(`WebSocket mở được: ${sockets.filter(Boolean).length}/${USERS}`);

// 4. Gửi tin theo tốc độ
const sendMs = [];
const errors = {};
let sent = 0;
let expectedTotal = 0;
const t0 = Date.now();
await new Promise((done) => {
  const timer = setInterval(() => {
    if (Date.now() - t0 > DURATION * 1000) {
      clearInterval(timer);
      return done();
    }
    for (let k = 0; k < Math.max(1, RATE / 10); k++) {
      const u = Math.floor(Math.random() * USERS);
      if (!groupsOf[u].length) continue;
      const g = groups[groupsOf[u][Math.floor(Math.random() * groupsOf[u].length)]];
      api(`/api/conversations/${g.id}/messages`, { token: tokens[u], method: "POST", body: { text: `lt:${Date.now()}` } }).then((r) => {
        if (r.status !== 200) return void (errors[r.status] = (errors[r.status] ?? 0) + 1);
        sent++;
        sendMs.push(r.ms);
        expected.set(r.data.message.id, g.members.length - 1);
        expectedTotal += g.members.length - 1;
      });
    }
  }, 100);
});
await new Promise((r) => setTimeout(r, 5000)); // chờ tin cuối tới nơi

console.log("\n=== Kết quả ===");
console.log(`Gửi thành công: ${sent} tin (${(sent / DURATION).toFixed(1)} tin/giây)  · lỗi: ${JSON.stringify(errors)}`);
console.log(`Độ trễ gửi (API):            ${fmt(sendMs)}`);
console.log(`Độ trễ tới người nhận (WS):  ${fmt(delivery)}`);
console.log(`Tới đủ người nhận: ${delivered}/${expectedTotal} (${((100 * delivered) / Math.max(1, expectedTotal)).toFixed(1)}%) · lỗi WebSocket: ${wsErrors}`);
for (const s of sockets) s?.close();
process.exit(0);
