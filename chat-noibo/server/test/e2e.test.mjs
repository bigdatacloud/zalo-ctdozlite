// Kiểm thử đầu-cuối trên `wrangler dev` cục bộ (D1 + R2 + Durable Objects thật của workerd).
// Chạy: npm test   (tự khởi động wrangler dev trên cổng ngẫu nhiên với dữ liệu tạm)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const state = mkdtempSync(join(tmpdir(), "chat-noibo-"));
let proc;

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
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "chat_noibo", "--local", "--persist-to", state], { stdio: "ignore" });
  proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", state, "--var", "ADMIN_BOOTSTRAP_TOKEN:t0ken-khoi-tao"], {
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
