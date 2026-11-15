// Kiểm thử đầu-cuối trên `wrangler dev` cục bộ (D1 + R2 + Durable Objects thật của workerd).
// Chạy: npm test   (tự khởi động wrangler dev trên cổng ngẫu nhiên với dữ liệu tạm)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const state = mkdtempSync(join(tmpdir(), "chat-noibo-"));
let proc;

// Máy chủ FCM giả: cấp access token (sau khi kiểm chữ ký JWT RS256) và ghi lại thông báo gửi đi.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fcm = { sent: [], jwtOk: 0, jwtBad: 0 };
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url === "/token") {
      const jwt = new URLSearchParams(body).get("assertion") ?? "";
      const [h, p, sig] = jwt.split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
      ok ? fcm.jwtOk++ : fcm.jwtBad++;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(ok ? { access_token: "fake-access", expires_in: 3600 } : { error: "bad jwt" }));
    }
    if (req.url === "/v1/projects/test-proj/messages:send") {
      const m = JSON.parse(body).message;
      if (req.headers.authorization !== "Bearer fake-access") { res.writeHead(401); return res.end(); }
      if (m.token.startsWith("bad-")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }));
      }
      fcm.sent.push(m);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ name: "projects/test-proj/messages/1" }));
    }
    res.writeHead(404); res.end();
  });
});

async function api(path, { token, method = "GET", body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let b;
  if (raw !== undefined) b = raw;
  else if (body !== undefined) {
    h["content-type"] = "application/json";
    b = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, { method, headers: h, body: b });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
}

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  const sa = {
    project_id: "test-proj",
    client_email: "push@test-proj.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: `${mockBase}/token`,
  };
  writeFileSync(join(state, "test.env"), `ADMIN_BOOTSTRAP_TOKEN=t0ken-khoi-tao\nFCM_API_BASE=${mockBase}\nFCM_SERVICE_ACCOUNT='${JSON.stringify(sa)}'\n`);
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "chat_noibo", "--local", "--persist-to", state], { stdio: "ignore" });
  proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", state, "--env-file", join(state, "test.env")], {
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/api/me");
      if (r.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev không khởi động được");
});

after(() => {
  mock.close();
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {}
  rmSync(state, { recursive: true, force: true });
});

const ctx = {};

test("khởi tạo quản trị viên và tài khoản", async () => {
  let r = await api("/api/admin/bootstrap", { method: "POST", body: { token: "sai", username: "admin", display_name: "Quản trị", password: "matkhau-admin" } });
  assert.equal(r.status, 403);
  r = await api("/api/admin/bootstrap", { method: "POST", body: { token: "t0ken-khoi-tao", username: "admin", display_name: "Quản trị", password: "matkhau-admin" } });
  assert.equal(r.status, 200);
  r = await api("/api/admin/bootstrap", { method: "POST", body: { token: "t0ken-khoi-tao", username: "x", display_name: "x", password: "xxxxxxxx" } });
  assert.equal(r.status, 409, "chỉ khởi tạo được một lần");

  r = await api("/api/auth/login", { method: "POST", body: { username: "admin", password: "matkhau-admin", platform: "windows" } });
  assert.equal(r.status, 200);
  ctx.admin = r.data.token;

  for (const [u, n] of [["nv001", "Nguyễn Văn An"], ["nv002", "Trần Thị Bình"], ["nv003", "Lê Văn Cường"]]) {
    r = await api("/api/admin/users", { token: ctx.admin, method: "POST", body: { username: u, display_name: n, department: "Xưởng 1", password: "matkhau123" } });
    assert.equal(r.status, 200);
    ctx[u + "_id"] = r.data.user_id;
  }
  r = await api("/api/auth/login", { method: "POST", body: { username: "nv001", password: "matkhau123", platform: "windows" } });
  ctx.an = r.data.token;
  r = await api("/api/auth/login", { method: "POST", body: { username: "nv002", password: "matkhau123", platform: "android" } });
  ctx.binh = r.data.token;
  ctx.binh_device = r.data.me.device_id;
  r = await api("/api/auth/login", { method: "POST", body: { username: "nv003", password: "matkhau123", platform: "windows" } });
  ctx.cuong = r.data.token;

  r = await api("/api/auth/login", { method: "POST", body: { username: "nv001", password: "sai-mat-khau" } });
  assert.equal(r.status, 401);
});

test("nhắn tin 1-1 và nhận thời gian thực qua WebSocket", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?token=${ctx.binh}`);
  const got = [];
  await new Promise((res, rej) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      got.push(m);
      if (m.type === "hello") res();
    };
    ws.onerror = rej;
  });
  let r = await api("/api/conversations/dm", { token: ctx.an, method: "POST", body: { user_id: ctx.nv002_id } });
  assert.equal(r.status, 200);
  ctx.dm = r.data.conversation.id;
  assert.equal(r.data.conversation.name, "Trần Thị Bình");
  assert.equal(r.data.conversation.policy.can_upload, false);

  const r2 = await api("/api/conversations/dm", { token: ctx.binh, method: "POST", body: { user_id: ctx.nv001_id } });
  assert.equal(r2.data.conversation.id, ctx.dm, "cùng một cặp thì cùng một hội thoại");

  r = await api(`/api/conversations/${ctx.dm}/messages`, { token: ctx.an, method: "POST", body: { text: "Chào chị Bình", client_id: "c1" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.message.seq, 1);
  const again = await api(`/api/conversations/${ctx.dm}/messages`, { token: ctx.an, method: "POST", body: { text: "Chào chị Bình", client_id: "c1" } });
  assert.equal(again.data.message.id, r.data.message.id, "client_id chống gửi trùng");

  for (let i = 0; i < 40 && !got.some((m) => m.type === "message"); i++) await new Promise((r) => setTimeout(r, 100));
  const evt = got.find((m) => m.type === "message");
  assert.ok(evt, "Bình phải nhận được tin qua WebSocket");
  assert.equal(evt.message.text, "Chào chị Bình");
  ws.close();

  r = await api("/api/conversations", { token: ctx.binh });
  const conv = r.data.conversations.find((c) => c.id === ctx.dm);
  assert.equal(conv.unread, 1);
  assert.equal(conv.last_message.text, "Chào chị Bình");
});

test("cấm gửi tệp vào tin nhắn cá nhân", async () => {
  const r = await api(`/api/conversations/${ctx.dm}/files`, {
    token: ctx.an,
    method: "POST",
    headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent("bản vẽ.pdf") },
    raw: new TextEncoder().encode("%PDF-1.4 bí mật"),
  });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "policy_denied");
});

test("nhóm thường do nhân viên tạo: không được gửi tệp", async () => {
  const r = await api("/api/conversations/group", { token: ctx.an, method: "POST", body: { name: "Hội cà phê", member_ids: [ctx.nv002_id] } });
  assert.equal(r.status, 200);
  ctx.casual = r.data.conversation.id;
  assert.equal(r.data.conversation.managed, false);
  const up = await api(`/api/conversations/${ctx.casual}/files`, {
    token: ctx.an,
    method: "POST",
    headers: { "content-type": "text/plain", "x-file-name": "a.txt" },
    raw: "abc",
  });
  assert.equal(up.status, 403);
});

test("nhóm công ty quản lý: được gửi tệp, cấm chuyển tiếp ra ngoài", async () => {
  let r = await api("/api/admin/groups", { token: ctx.admin, method: "POST", body: { name: "Xưởng 1 - Sản xuất", member_ids: [ctx.nv001_id, ctx.nv002_id, ctx.nv003_id] } });
  assert.equal(r.status, 200);
  ctx.managed = r.data.conversation_id;
  r = await api("/api/admin/groups", { token: ctx.admin, method: "POST", body: { name: "Xưởng 1 - Kỹ thuật", member_ids: [ctx.nv001_id, ctx.nv003_id] } });
  ctx.managed2 = r.data.conversation_id;

  r = await api(`/api/conversations/${ctx.managed}`, { token: ctx.an });
  assert.equal(r.data.conversation.policy.can_upload, true);
  assert.equal(r.data.conversation.policy.can_forward_out, false);
  assert.equal(r.data.conversation.policy.can_copy, false);

  const content = new TextEncoder().encode("BOM sản phẩm A - tài liệu nội bộ");
  r = await api(`/api/conversations/${ctx.managed}/files?client_id=f1`, {
    token: ctx.an,
    method: "POST",
    headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("BOM sản phẩm.txt") },
    raw: content,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ctx.fileMsg = r.data.message;
  assert.equal(r.data.message.file.name, "BOM sản phẩm.txt");

  // Chuyển tiếp tệp sang chat 1-1 / nhóm thường / nhóm công ty khác
  r = await api(`/api/messages/${ctx.fileMsg.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.dm } });
  assert.equal(r.status, 403, "cấm chuyển tệp từ nhóm công ty sang chat cá nhân");
  r = await api(`/api/messages/${ctx.fileMsg.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.casual } });
  assert.equal(r.status, 403);
  r = await api(`/api/messages/${ctx.fileMsg.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.managed2 } });
  assert.equal(r.status, 403, "mặc định nhóm công ty cấm chuyển tiếp ra ngoài, kể cả sang nhóm công ty khác");

  // Quản trị viên mở chuyển tiếp: chỉ được sang nhóm công ty
  await api(`/api/admin/conversations/${ctx.managed}`, { token: ctx.admin, method: "PATCH", body: { allow_forward_out: true } });
  r = await api(`/api/messages/${ctx.fileMsg.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.dm } });
  assert.equal(r.status, 403, "vẫn cấm sang chat cá nhân");
  r = await api(`/api/messages/${ctx.fileMsg.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.managed2 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.message.forwarded, true);

  // Không phải thành viên thì không chuyển tiếp/đọc được
  r = await api(`/api/messages/${ctx.fileMsg.id}/forward`, { token: ctx.binh, method: "POST", body: { conversation_id: ctx.managed2 } });
  assert.equal(r.status, 404);
});

test("mở tệp: máy Windows được xem, điện thoại cá nhân chỉ xem, không ai được lưu khi nhóm cấm lưu", async () => {
  const fid = ctx.fileMsg.file.id;
  let r = await api(`/api/files/${fid}`, { token: ctx.an });
  assert.equal(r.status, 200);
  assert.equal(new TextDecoder().decode(r.data), "BOM sản phẩm A - tài liệu nội bộ");
  assert.equal(r.headers.get("x-file-access"), "view");
  assert.equal(r.headers.get("cache-control"), "private, no-store");

  r = await api(`/api/files/${fid}?purpose=save`, { token: ctx.an });
  assert.equal(r.status, 403, "nhóm mặc định cấm lưu tệp ra máy");

  await api(`/api/admin/conversations/${ctx.managed}`, { token: ctx.admin, method: "PATCH", body: { allow_save_file: true } });
  r = await api(`/api/files/${fid}?purpose=save`, { token: ctx.an });
  assert.equal(r.status, 200, "Windows: nhóm cho lưu thì được lưu");
  r = await api(`/api/files/${fid}?purpose=save`, { token: ctx.binh });
  assert.equal(r.status, 403, "điện thoại cá nhân: chỉ xem");
  r = await api(`/api/files/${fid}`, { token: ctx.binh });
  assert.equal(r.status, 200);

  await api(`/api/admin/devices/${ctx.binh_device}`, { token: ctx.admin, method: "PATCH", body: { trusted: true } });
  r = await api(`/api/files/${fid}?purpose=save`, { token: ctx.binh });
  assert.equal(r.status, 200, "điện thoại công ty cấp (đã tin cậy) được lưu");

  await api("/api/admin/settings", { token: ctx.admin, method: "PATCH", body: { mobile_untrusted_files: "deny" } });
  await api(`/api/admin/devices/${ctx.binh_device}`, { token: ctx.admin, method: "PATCH", body: { trusted: false } });
  r = await api(`/api/files/${fid}`, { token: ctx.binh });
  assert.equal(r.status, 403, "chế độ deny: điện thoại cá nhân không mở được tệp");
});

test("thu hồi tin nhắn chặn luôn quyền mở tệp", async () => {
  let r = await api(`/api/messages/${ctx.fileMsg.id}/recall`, { token: ctx.cuong, method: "POST" });
  assert.equal(r.status, 403, "không thu hồi tin của người khác");
  r = await api(`/api/messages/${ctx.fileMsg.id}/recall`, { token: ctx.an, method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.data.message.recalled, true);
  // Bản chuyển tiếp ở nhóm Kỹ thuật vẫn còn -> An vẫn mở được qua nhóm đó, Bình (không ở nhóm Kỹ thuật) thì không.
  await api("/api/admin/settings", { token: ctx.admin, method: "PATCH", body: { mobile_untrusted_files: "view" } });
  r = await api(`/api/files/${ctx.fileMsg.file.id}`, { token: ctx.binh });
  assert.equal(r.status, 404);
  r = await api(`/api/files/${ctx.fileMsg.file.id}`, { token: ctx.an });
  assert.equal(r.status, 200);
});

test("khóa tài khoản: phiên bị hủy, WebSocket nhận lệnh xóa dữ liệu", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?token=${ctx.cuong}`);
  const got = [];
  await new Promise((res, rej) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      got.push(m);
      if (m.type === "hello") res();
    };
    ws.onerror = rej;
  });
  const r = await api(`/api/admin/users/${ctx.nv003_id}`, { token: ctx.admin, method: "PATCH", body: { status: "disabled" } });
  assert.equal(r.status, 200);
  for (let i = 0; i < 40 && !got.some((m) => m.type === "revoked"); i++) await new Promise((r) => setTimeout(r, 100));
  const ev = got.find((m) => m.type === "revoked");
  assert.ok(ev && ev.wipe === true);
  const me = await api("/api/me", { token: ctx.cuong });
  assert.equal(me.status, 401);
});

test("nhật ký kiểm soát ghi lại các thao tác bị chặn", async () => {
  const r = await api("/api/admin/audit?allowed=0&limit=200", { token: ctx.admin });
  assert.equal(r.status, 200);
  const actions = r.data.audit.map((a) => a.action);
  assert.ok(actions.includes("upload"));
  assert.ok(actions.includes("forward"));
  assert.ok(actions.includes("file_save"));
  assert.ok(actions.includes("login"));
  const nonAdmin = await api("/api/admin/audit", { token: ctx.an });
  assert.equal(nonAdmin.status, 403);
});

test("tài khoản bên ngoài: chỉ hoạt động trong nhóm công ty mở cho đơn vị của họ", async () => {
  const mk = async (username, organization, expires_at) => {
    const r = await api("/api/admin/users", {
      token: ctx.admin,
      method: "POST",
      body: { username, display_name: `Đại diện ${organization}`, kind: "external", organization, password: "matkhau123", expires_at },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user_id;
  };
  ctx.ncc01_id = await mk("ncc01", "Công ty Gỗ ABC");
  ctx.ncc02_id = await mk("ncc02", "Công ty Sơn XYZ");
  await mk("ncc03", "Công ty Cũ", "2020-01-01");

  let r = await api("/api/admin/users", { token: ctx.admin, method: "POST", body: { username: "ncc04", display_name: "x", kind: "external", password: "matkhau123" } });
  assert.equal(r.status, 400, "tài khoản bên ngoài bắt buộc có tên đơn vị");

  r = await api("/api/auth/login", { method: "POST", body: { username: "ncc03", password: "matkhau123" } });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, "account_expired");

  r = await api("/api/auth/login", { method: "POST", body: { username: "ncc01", password: "matkhau123", platform: "android" } });
  ctx.ncc = r.data.token;
  assert.equal(r.data.me.kind, "external");

  // Không được đưa người bên ngoài vào nhóm nội bộ
  r = await api(`/api/admin/conversations/${ctx.managed}/members`, { token: ctx.admin, method: "POST", body: { user_ids: [ctx.ncc01_id] } });
  assert.equal(r.status, 403);
  r = await api("/api/conversations/group", { token: ctx.an, method: "POST", body: { name: "Lén", member_ids: [ctx.ncc01_id] } });
  assert.equal(r.status, 403);

  // Nhóm bên ngoài gắn với đúng một đơn vị
  r = await api("/api/admin/groups", {
    token: ctx.admin,
    method: "POST",
    body: { name: "Mua hàng - Gỗ ABC", external: true, organization: "Công ty Gỗ ABC", member_ids: [ctx.nv001_id, ctx.ncc01_id, ctx.ncc02_id] },
  });
  assert.equal(r.status, 403, "NCC khác đơn vị không được vào chung nhóm");
  r = await api("/api/admin/groups", {
    token: ctx.admin,
    method: "POST",
    body: { name: "Mua hàng - Gỗ ABC", external: true, organization: "Công ty Gỗ ABC", member_ids: [ctx.nv001_id, ctx.ncc01_id] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ctx.ext = r.data.conversation_id;
  r = await api(`/api/admin/conversations/${ctx.ext}/members`, { token: ctx.admin, method: "POST", body: { user_ids: [ctx.ncc02_id] } });
  assert.equal(r.status, 403);

  // Người bên ngoài không xem danh bạ, không nhắn riêng, không tạo nhóm
  assert.equal((await api("/api/users", { token: ctx.ncc })).status, 403);
  assert.equal((await api("/api/conversations/dm", { token: ctx.ncc, method: "POST", body: { user_id: ctx.nv001_id } })).status, 403);
  assert.equal((await api("/api/conversations/group", { token: ctx.ncc, method: "POST", body: { name: "x", member_ids: [] } })).status, 403);
  // Nhân viên cũng không nhắn riêng được cho người bên ngoài, và danh bạ không hiện họ
  assert.equal((await api("/api/conversations/dm", { token: ctx.an, method: "POST", body: { user_id: ctx.ncc01_id } })).status, 404);
  r = await api("/api/users", { token: ctx.an });
  assert.ok(!r.data.users.some((u) => u.username.startsWith("ncc")));

  r = await api("/api/conversations", { token: ctx.ncc });
  assert.deepEqual(r.data.conversations.map((c) => c.id), [ctx.ext]);
  assert.equal(r.data.conversations[0].external, true);
  assert.equal(r.data.conversations[0].policy.can_forward_out, false);

  r = await api(`/api/conversations/${ctx.ext}`, { token: ctx.ncc });
  const an = r.data.members.find((m) => m.id === ctx.nv001_id);
  assert.equal(an.department, "", "người bên ngoài không thấy phòng ban nội bộ");
});

test("nhóm bên ngoài: gửi tệp trực tiếp được (có nhật ký), chuyển tiếp vào thì bị chặn", async () => {
  let r = await api(`/api/conversations/${ctx.ext}/files`, {
    token: ctx.an,
    method: "POST",
    headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("Đơn đặt hàng PO-001.txt") },
    raw: "PO-001: 200 tấm gỗ",
  });
  assert.equal(r.status, 202, "nhân viên thường gửi ra ngoài phải chờ duyệt");
  r = await api(`/api/approvals/${r.data.pending.id}/approve`, { token: ctx.admin, method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const po = r.data.message;
  r = await api(`/api/files/${po.file.id}?purpose=save`, { token: ctx.ncc });
  assert.equal(r.status, 200, "NCC tải được đơn hàng gửi cho họ");

  r = await api(`/api/conversations/${ctx.ext}/messages`, { token: ctx.ncc, method: "POST", body: { text: "Báo giá: 450.000đ/tấm" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.message.sender_external, true);
  assert.equal(r.data.message.sender_org, "Công ty Gỗ ABC");
  const quote = r.data.message;

  // Mang báo giá của NCC vào nhóm nội bộ: được
  r = await api(`/api/messages/${quote.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.managed2 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Đưa tin nội bộ ra nhóm bên ngoài bằng chuyển tiếp: chặn
  const internal = await api(`/api/conversations/${ctx.managed2}/messages`, { token: ctx.an, method: "POST", body: { text: "Giá vốn nội bộ 300.000đ" } });
  r = await api(`/api/messages/${internal.data.message.id}/forward`, { token: ctx.an, method: "POST", body: { conversation_id: ctx.ext } });
  assert.equal(r.status, 403);
  // NCC không chuyển tiếp được gì
  r = await api(`/api/messages/${quote.id}/forward`, { token: ctx.ncc, method: "POST", body: { conversation_id: ctx.ext } });
  assert.equal(r.status, 403);

  r = await api("/api/admin/audit?action=approve_external", { token: ctx.admin });
  assert.ok(r.data.audit.some((a) => a.detail.includes("Công ty Gỗ ABC")));
});

test("tài khoản bên ngoài hết hạn thì mất truy cập ngay", async () => {
  let r = await api(`/api/admin/users/${ctx.ncc01_id}`, { token: ctx.admin, method: "PATCH", body: { expires_at: Date.now() - 1000 } });
  assert.equal(r.status, 200);
  r = await api("/api/me", { token: ctx.ncc });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, "account_expired");
});

test("duyệt tệp gửi ra ngoài: đối tác không thấy gì cho tới khi được duyệt", async () => {
  let r = await api("/api/admin/users", { token: ctx.admin, method: "POST", body: { username: "ncc05", display_name: "Đại diện DEF", kind: "external", organization: "Công ty Bao bì DEF", password: "matkhau123" } });
  const ncc05 = r.data.user_id;
  r = await api("/api/auth/login", { method: "POST", body: { username: "ncc05", password: "matkhau123", platform: "windows" } });
  const ncc = r.data.token;
  r = await api("/api/admin/groups", { token: ctx.admin, method: "POST", body: { name: "Mua hàng - Bao bì DEF", external: true, organization: "Công ty Bao bì DEF", member_ids: [ctx.nv001_id, ctx.nv002_id, ncc05] } });
  const g = r.data.conversation_id;
  // Giao quyền duyệt cho chị Bình
  r = await api(`/api/admin/conversations/${g}/members/${ctx.nv002_id}`, { token: ctx.admin, method: "PATCH", body: { role: "admin" } });
  assert.equal(r.status, 200);
  r = await api(`/api/admin/conversations/${g}/members/${ncc05}`, { token: ctx.admin, method: "PATCH", body: { role: "admin" } });
  assert.equal(r.status, 400, "không giao quyền duyệt cho người bên ngoài");

  r = await api(`/api/conversations/${g}`, { token: ctx.an });
  assert.equal(r.data.conversation.policy.needs_approval, true);
  assert.equal(r.data.conversation.policy.can_approve, false);
  r = await api(`/api/conversations/${g}`, { token: ctx.binh });
  assert.equal(r.data.conversation.policy.needs_approval, false);
  assert.equal(r.data.conversation.policy.can_approve, true);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?token=${ncc}`);
  const nccEvents = [];
  await new Promise((res) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); nccEvents.push(m); if (m.type === "hello") res(); }; });

  const upload = (text) => api(`/api/conversations/${g}/files`, {
    token: ctx.an, method: "POST", headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent(text + ".txt") }, raw: text,
  });
  r = await upload("Bản vẽ khay B12");
  assert.equal(r.status, 202);
  const p1 = r.data.pending;
  assert.equal(p1.status, "pending");

  // Đối tác: không có tin, không mở được tệp, không xem trước được
  r = await api(`/api/conversations/${g}/messages`, { token: ncc });
  assert.ok(!r.data.messages.some((m) => m.file), "đối tác không thấy tệp chờ duyệt");
  assert.equal((await api(`/api/files/${p1.file.id}`, { token: ncc })).status, 404);
  assert.equal((await api(`/api/approvals/${p1.id}/file`, { token: ncc })).status, 403);
  assert.equal((await api(`/api/conversations/${g}/pending`, { token: ncc })).data.approvals.length, 0);

  // Người gửi thấy tệp của mình đang chờ; không tự duyệt được
  r = await api(`/api/conversations/${g}/pending`, { token: ctx.an });
  assert.equal(r.data.approvals.length, 1);
  assert.equal((await api(`/api/approvals/${p1.id}/approve`, { token: ctx.an, method: "POST" })).status, 403);

  // Người duyệt thấy trong danh sách của mình và xem trước được
  r = await api("/api/approvals", { token: ctx.binh });
  assert.ok(r.data.approvals.some((a) => a.id === p1.id));
  r = await api(`/api/approvals/${p1.id}/file`, { token: ctx.binh });
  assert.equal(new TextDecoder().decode(r.data), "Bản vẽ khay B12");

  assert.equal((await api(`/api/approvals/${p1.id}/reject`, { token: ctx.binh, method: "POST", body: {} })).status, 400, "từ chối phải có lý do");
  r = await api(`/api/approvals/${p1.id}/approve`, { token: ctx.binh, method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.data.message.sender_id, ctx.nv001_id, "tin đứng tên người gửi ban đầu");
  assert.equal((await api(`/api/approvals/${p1.id}/approve`, { token: ctx.admin, method: "POST" })).status, 409, "không duyệt hai lần");
  r = await api(`/api/files/${p1.file.id}?purpose=save`, { token: ncc });
  assert.equal(r.status, 200, "sau khi duyệt đối tác tải được");

  // Từ chối
  r = await upload("Bảng giá vốn nội bộ");
  const p2 = r.data.pending;
  r = await api(`/api/approvals/${p2.id}/reject`, { token: ctx.admin, method: "POST", body: { reason: "Tài liệu nội bộ, không gửi NCC" } });
  assert.equal(r.status, 200);
  r = await api(`/api/conversations/${g}/pending`, { token: ctx.an });
  const rej = r.data.approvals.find((a) => a.id === p2.id);
  assert.equal(rej.status, "rejected");
  assert.equal(rej.reason, "Tài liệu nội bộ, không gửi NCC");
  assert.equal((await api(`/api/files/${p2.file.id}`, { token: ncc })).status, 404);

  // Rút lại
  r = await upload("Gửi nhầm");
  assert.equal((await api(`/api/approvals/${r.data.pending.id}/cancel`, { token: ctx.an, method: "POST" })).status, 200);

  // Người duyệt tự gửi thì đi thẳng
  r = await api(`/api/conversations/${g}/files`, { token: ctx.binh, method: "POST", headers: { "content-type": "text/plain", "x-file-name": "po.txt" }, raw: "PO-002" });
  assert.equal(r.status, 200);
  // Đối tác gửi vào thì không cần duyệt
  r = await api(`/api/conversations/${g}/files`, { token: ncc, method: "POST", headers: { "content-type": "text/plain", "x-file-name": "bao-gia.txt" }, raw: "Báo giá" });
  assert.equal(r.status, 200);

  await new Promise((res) => setTimeout(res, 300));
  ws.close();
  const leaked = nccEvents.filter((e) => e.type === "approval_changed" || (e.type === "message" && /khay|giá vốn|nhầm/i.test(e.message.file?.name ?? "") && e.message.file?.name !== "Bản vẽ khay B12.txt"));
  assert.deepEqual(leaked, [], "đối tác không nhận sự kiện nào về tệp chờ duyệt / bị từ chối");

  r = await api("/api/admin/audit?limit=300", { token: ctx.admin });
  const acts = r.data.audit.map((a) => a.action);
  for (const a of ["upload_pending", "approve_external", "reject_external", "cancel_external", "approval_preview"]) assert.ok(acts.includes(a), a);
});

test("thông báo đẩy: không bao giờ chứa nội dung tin nhắn", async () => {
  const wait = async (pred) => { for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 100)); };
  let r = await api("/api/devices/push-token", { token: ctx.binh, method: "POST", body: { token: "tok-binh" } });
  assert.equal(r.status, 200);
  // Thiết bị thứ hai của Bình có token đã hết hiệu lực
  r = await api("/api/auth/login", { method: "POST", body: { username: "nv002", password: "matkhau123", platform: "ios" } });
  const binh2 = r.data.token;
  await api("/api/devices/push-token", { token: binh2, method: "POST", body: { token: "bad-ios" } });

  fcm.sent.length = 0;
  await api(`/api/conversations/${ctx.dm}/messages`, { token: ctx.an, method: "POST", body: { text: "Mật khẩu kho là 1234" } });
  await wait(() => fcm.sent.length >= 1);
  assert.equal(fcm.sent.length, 1, "chỉ gửi tới người nhận, không gửi cho người gửi");
  const m = fcm.sent[0];
  assert.equal(m.token, "tok-binh");
  assert.equal(m.notification.title, "Nguyễn Văn An");
  assert.ok(!JSON.stringify(m).includes("1234"), "nội dung tin không được đi qua Google/Apple");
  assert.equal(m.data.conversation_id, ctx.dm);
  assert.ok(fcm.jwtOk >= 1 && fcm.jwtBad === 0, "JWT ký RS256 hợp lệ");

  // Token hỏng đã bị gỡ: lần sau chỉ còn một lượt gửi, không thử lại bad-ios
  fcm.sent.length = 0;
  await api("/api/admin/settings", { token: ctx.admin, method: "PATCH", body: { push_content: "none" } });
  await api(`/api/conversations/${ctx.dm}/messages`, { token: ctx.an, method: "POST", body: { text: "Lần 2" } });
  await wait(() => fcm.sent.length >= 1);
  assert.equal(fcm.sent[0].notification.body, "Bạn có tin nhắn mới");
  assert.equal(fcm.sent[0].notification.title, "Chat Nội Bộ");
  r = await api("/api/admin/devices", { token: ctx.admin });
  assert.ok(!r.data.devices.some((d) => "push_token" in d), "không lộ push token ra trang quản trị");
  assert.equal(r.data.devices.find((d) => d.username === "nv002" && d.platform === "ios").has_push, 0, "token hỏng đã bị gỡ");

  // Đăng xuất thì không nhận thông báo nữa
  await api("/api/auth/logout", { token: ctx.binh, method: "POST" });
  fcm.sent.length = 0;
  await api(`/api/conversations/${ctx.dm}/messages`, { token: ctx.an, method: "POST", body: { text: "Lần 3" } });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fcm.sent.length, 0);
});
