import { authenticate, createSession, hashPassword, Principal, validatePassword, verifyPassword } from "./auth";
import { canForward, canJoin, canUpload, clientFlags, ConvPolicyRow, defaultsFor, fileAccess, isApprover, needsApproval, requireInternal } from "./policy";
import { approvalRoutes, notifyApprovers, pendingOut } from "./approvals";
import { adminRoutes, sweepExpired } from "./admin";
import { audit, Env, getSettings, HttpError, json, newId, now, readJson, sha256Hex, str } from "./util";

export { UserHub } from "./hub";

export type Ctx = { env: Env; req: Request; url: URL; exec: ExecutionContext };
export type Handler = (c: Ctx, p: Record<string, string>) => Promise<Response>;

export interface ConvRow extends ConvPolicyRow {
  name: string;
  created_by: string;
  created_at: number;
  last_seq: number;
  last_msg_at: number;
  member_role: string;
  last_read_seq: number;
}

const routes: [string, RegExp, string[], Handler][] = [];
export function route(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push([method, re, keys, h]);
}

function cors(env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": env.CORS_ORIGIN || "*",
    "access-control-allow-headers": "authorization, content-type, x-file-name",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-expose-headers": "x-file-access, content-disposition",
  };
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    let res: Response;
    try {
      res = await dispatch({ env, req, url, exec });
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.code, message: e.message }, e.status);
      else {
        console.error(e);
        res = json({ error: "internal", message: "Lỗi máy chủ" }, 500);
      }
    }
    if (res.status === 101) return res;
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors(env))) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(_ev: ScheduledController, env: Env, exec: ExecutionContext) {
    exec.waitUntil(sweepExpired(env));
  },
} satisfies ExportedHandler<Env>;

async function dispatch(c: Ctx): Promise<Response> {
  for (const [m, re, keys, h] of routes) {
    if (m !== c.req.method) continue;
    const mm = re.exec(c.url.pathname);
    if (!mm) continue;
    const p: Record<string, string> = {};
    keys.forEach((k, i) => (p[k] = decodeURIComponent(mm[i + 1])));
    return h(c, p);
  }
  throw new HttpError(404, "not_found", "Không tìm thấy");
}

// ---------------------------------------------------------------------------
// Tiện ích dùng chung

export async function loadConv(env: Env, convId: string, userId: string): Promise<ConvRow> {
  const row = await env.DB.prepare(
    `SELECT c.*, m.role AS member_role, m.last_read_seq FROM conversations c
       JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
      WHERE c.id = ?`,
  )
    .bind(userId, convId)
    .first<ConvRow>();
  if (!row) throw new HttpError(404, "conversation_not_found", "Không tìm thấy hội thoại");
  return row;
}

async function memberIds(env: Env, convId: string): Promise<string[]> {
  const r = await env.DB.prepare("SELECT user_id FROM members WHERE conversation_id = ?").bind(convId).all<{ user_id: string }>();
  return r.results.map((x) => x.user_id);
}

export function fanout(c: Ctx, userIds: string[], event: unknown) {
  c.exec.waitUntil(
    Promise.allSettled(userIds.map((u) => c.env.HUB.get(c.env.HUB.idFromName(u)).push(event))),
  );
}

export async function fanoutConv(c: Ctx, convId: string, event: unknown) {
  fanout(c, await memberIds(c.env, convId), event);
}

interface MsgRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  sender_org: string;
  kind: string;
  text: string;
  file_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  reply_to: string | null;
  forwarded_from: string | null;
  client_id: string | null;
  created_at: number;
  recalled_at: number | null;
}

const MSG_SELECT = `SELECT m.*, u.display_name AS sender_name, u.kind AS sender_kind, u.organization AS sender_org, f.name AS file_name, f.mime AS file_mime, f.size AS file_size
  FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN files f ON f.id = m.file_id`;

function msgOut(r: MsgRow) {
  const recalled = r.recalled_at != null;
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    seq: r.seq,
    sender_id: r.sender_id,
    sender_name: r.sender_name,
    sender_external: r.sender_kind === "external",
    sender_org: r.sender_kind === "external" ? r.sender_org : "",
    kind: r.kind,
    text: recalled ? "" : r.text,
    file: !recalled && r.file_id ? { id: r.file_id, name: r.file_name, mime: r.file_mime, size: r.file_size } : null,
    reply_to: r.reply_to,
    forwarded: r.forwarded_from != null,
    client_id: r.client_id,
    created_at: r.created_at,
    recalled,
  };
}

async function loadMsg(env: Env, id: string): Promise<MsgRow | null> {
  return env.DB.prepare(`${MSG_SELECT} WHERE m.id = ?`).bind(id).first<MsgRow>();
}

/** Chèn tin nhắn với số thứ tự tăng dần trong hội thoại (một câu lệnh, nguyên tử trong D1). */
export async function insertMessage(
  c: Ctx,
  convId: string,
  senderId: string,
  m: { kind: string; text: string; file_id?: string | null; reply_to?: string | null; forwarded_from?: string | null; client_id?: string | null },
) {
  if (m.client_id) {
    const dup = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.conversation_id=? AND m.sender_id=? AND m.client_id=?`)
      .bind(convId, senderId, m.client_id)
      .first<MsgRow>();
    if (dup) return msgOut(dup);
  }
  const id = newId("m");
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO messages(id,conversation_id,seq,sender_id,kind,text,file_id,reply_to,forwarded_from,client_id,created_at)
       SELECT ?, ?, COALESCE(MAX(seq),0)+1, ?, ?, ?, ?, ?, ?, ?, ? FROM messages WHERE conversation_id = ?`,
    ).bind(id, convId, senderId, m.kind, m.text, m.file_id ?? null, m.reply_to ?? null, m.forwarded_from ?? null, m.client_id ?? null, t, convId),
    c.env.DB.prepare(
      `UPDATE conversations SET last_seq = (SELECT MAX(seq) FROM messages WHERE conversation_id = ?), last_msg_at = ? WHERE id = ?`,
    ).bind(convId, t, convId),
    c.env.DB.prepare(
      `UPDATE members SET last_read_seq = (SELECT MAX(seq) FROM messages WHERE conversation_id = ?) WHERE conversation_id = ? AND user_id = ?`,
    ).bind(convId, convId, senderId),
  ]);
  const out = msgOut((await loadMsg(c.env, id))!);
  await fanoutConv(c, convId, { type: "message", message: out });
  return out;
}

async function convOut(env: Env, conv: ConvRow, who: Principal, settings: Record<string, string>) {
  let name = conv.name;
  let peer: { id: string; display_name: string } | null = null;
  if (conv.kind === "dm") {
    peer = await env.DB.prepare(
      "SELECT u.id, u.display_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.user_id != ?",
    )
      .bind(conv.id, who.user_id)
      .first<{ id: string; display_name: string }>();
    name = peer?.display_name ?? "Hội thoại";
  }
  return {
    id: conv.id,
    kind: conv.kind,
    name,
    peer_id: peer?.id ?? null,
    managed: !!conv.managed,
    external: !!conv.external,
    organization: conv.organization,
    my_role: conv.member_role,
    last_seq: conv.last_seq,
    last_read_seq: conv.last_read_seq,
    unread: Math.max(0, conv.last_seq - conv.last_read_seq),
    last_msg_at: conv.last_msg_at,
    require_approval: !!conv.require_approval,
    policy: {
      ...clientFlags(conv, who, settings),
      needs_approval: needsApproval(conv, who, conv.member_role),
      can_approve: !!conv.external && isApprover(who, conv.member_role),
    },
  };
}

// ---------------------------------------------------------------------------
// Xác thực

route("POST", "/api/auth/login", async (c) => {
  const b = await readJson<{ username?: string; password?: string; platform?: string; device_name?: string }>(c.req);
  const username = str(b.username, "username", 64);
  const password = str(b.password, "password", 256);
  const platform = ["windows", "android", "ios", "web"].includes(b.platform ?? "") ? b.platform! : "other";

  const since = now() - 15 * 60 * 1000;
  const fails = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit WHERE action = 'login' AND allowed = 0 AND target = ? AND at > ?",
  )
    .bind(username.toLowerCase(), since)
    .first<{ n: number }>();
  if ((fails?.n ?? 0) >= 10) throw new HttpError(429, "too_many_attempts", "Sai mật khẩu quá nhiều lần, thử lại sau 15 phút");

  const u = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<{
    id: string;
    status: string;
    password_hash: string;
    password_salt: string;
    expires_at: number | null;
  }>();
  const ok = !!u && u.status === "active" && (await verifyPassword(password, u.password_hash, u.password_salt));
  if (ok && u!.expires_at && u!.expires_at < now()) {
    await audit(c.env, { user_id: u!.id, action: "login", target: username.toLowerCase(), allowed: false, detail: "expired" });
    throw new HttpError(401, "account_expired", "Tài khoản đã hết hạn sử dụng, liên hệ người phụ trách bên công ty");
  }
  if (!ok) {
    await audit(c.env, { user_id: u?.id, action: "login", target: username.toLowerCase(), allowed: false, detail: platform });
    throw new HttpError(401, "bad_credentials", "Sai mã nhân viên hoặc mật khẩu");
  }
  const deviceId = newId("d");
  const t = now();
  await c.env.DB.prepare("INSERT INTO devices(id,user_id,platform,name,created_at,last_seen) VALUES (?,?,?,?,?,?)")
    .bind(deviceId, u!.id, platform, (b.device_name ?? "").slice(0, 100), t, t)
    .run();
  const token = await createSession(c.env, u!.id, deviceId);
  await audit(c.env, { user_id: u!.id, device_id: deviceId, action: "login", target: username.toLowerCase(), allowed: true, detail: platform });
  const me = await authenticate(c.env, new Request(c.req.url, { headers: { authorization: `Bearer ${token}` } }));
  return json({ token, me });
});

route("POST", "/api/auth/logout", async (c) => {
  const me = await authenticate(c.env, c.req);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(me.device_id),
    c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(now(), me.device_id),
  ]);
  return json({ ok: true });
});

route("POST", "/api/auth/password", async (c) => {
  const me = await authenticate(c.env, c.req);
  const b = await readJson<{ old_password?: string; new_password?: string }>(c.req);
  const u = await c.env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
    .bind(me.user_id)
    .first<{ password_hash: string; password_salt: string }>();
  if (!(await verifyPassword(str(b.old_password, "old_password", 256), u!.password_hash, u!.password_salt)))
    throw new HttpError(400, "bad_credentials", "Mật khẩu hiện tại không đúng");
  const np = str(b.new_password, "new_password", 256);
  validatePassword(np);
  const h = await hashPassword(np);
  await c.env.DB.prepare("UPDATE users SET password_hash=?, password_salt=?, must_change_password=0 WHERE id=?")
    .bind(h.hash, h.salt, me.user_id)
    .run();
  return json({ ok: true });
});

route("GET", "/api/me", async (c) => {
  const me = await authenticate(c.env, c.req);
  c.exec.waitUntil(c.env.DB.prepare("UPDATE devices SET last_seen=? WHERE id=?").bind(now(), me.device_id).run());
  return json({ me });
});

route("GET", "/api/ws", async (c) => {
  const me = await authenticate(c.env, c.req);
  if (c.req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required");
  const stub = c.env.HUB.get(c.env.HUB.idFromName(me.user_id));
  const h = new Headers(c.req.headers);
  h.set("x-device-id", me.device_id);
  return stub.fetch(new Request(c.req.url, { headers: h }));
});

// ---------------------------------------------------------------------------
// Danh bạ

route("GET", "/api/users", async (c) => {
  const me = await authenticate(c.env, c.req);
  const d = requireInternal(me, "xem danh bạ công ty");
  if (!d.ok) throw new HttpError(403, "policy_denied", d.reason);
  const q = (c.url.searchParams.get("q") ?? "").trim();
  const like = `%${q}%`;
  const r = await c.env.DB.prepare(
    `SELECT id, username, display_name, department FROM users
      WHERE status = 'active' AND kind = 'internal' AND (? = '' OR display_name LIKE ? OR username LIKE ? OR department LIKE ?)
      ORDER BY display_name LIMIT 200`,
  )
    .bind(q, like, like, like)
    .all();
  return json({ users: r.results });
});

// ---------------------------------------------------------------------------
// Hội thoại

route("GET", "/api/conversations", async (c) => {
  const me = await authenticate(c.env, c.req);
  const settings = await getSettings(c.env);
  const r = await c.env.DB.prepare(
    `SELECT c.*, m.role AS member_role, m.last_read_seq FROM conversations c
       JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
      ORDER BY c.last_msg_at DESC, c.created_at DESC`,
  )
    .bind(me.user_id)
    .all<ConvRow>();
  const lastIds = r.results.filter((x) => x.last_seq > 0);
  const lasts = new Map<string, ReturnType<typeof msgOut>>();
  if (lastIds.length) {
    const stmts = lastIds.map((x) => c.env.DB.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? AND m.seq = ?`).bind(x.id, x.last_seq));
    const res = await c.env.DB.batch<MsgRow>(stmts);
    res.forEach((rr) => rr.results[0] && lasts.set(rr.results[0].conversation_id, msgOut(rr.results[0])));
  }
  const out = [];
  for (const conv of r.results) out.push({ ...(await convOut(c.env, conv, me, settings)), last_message: lasts.get(conv.id) ?? null });
  return json({ conversations: out });
});

route("POST", "/api/conversations/dm", async (c) => {
  const me = await authenticate(c.env, c.req);
  const ri = requireInternal(me, "nhắn tin riêng");
  if (!ri.ok) throw new HttpError(403, "policy_denied", ri.reason);
  const b = await readJson<{ user_id?: string }>(c.req);
  const other = str(b.user_id, "user_id", 64);
  if (other === me.user_id) throw new HttpError(400, "bad_field", "Không thể nhắn với chính mình");
  const peer = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND kind = 'internal'").bind(other).first();
  if (!peer) throw new HttpError(404, "user_not_found", "Không tìm thấy người dùng");
  const key = [me.user_id, other].sort().join(":");
  let id = (await c.env.DB.prepare("SELECT id FROM conversations WHERE dm_key = ?").bind(key).first<{ id: string }>())?.id;
  if (!id) {
    id = newId("c");
    const d = defaultsFor("dm", false);
    const t = now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO conversations(id,kind,dm_key,managed,allow_upload,allow_forward_out,allow_copy,allow_save_file,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dm_key) DO NOTHING`,
      ).bind(id, "dm", key, 0, d.allow_upload, d.allow_forward_out, d.allow_copy, d.allow_save_file, me.user_id, t),
      c.env.DB.prepare("INSERT OR IGNORE INTO members(conversation_id,user_id,role,joined_at) SELECT id, ?, 'member', ? FROM conversations WHERE dm_key = ?").bind(me.user_id, t, key),
      c.env.DB.prepare("INSERT OR IGNORE INTO members(conversation_id,user_id,role,joined_at) SELECT id, ?, 'member', ? FROM conversations WHERE dm_key = ?").bind(other, t, key),
    ]);
    id = (await c.env.DB.prepare("SELECT id FROM conversations WHERE dm_key = ?").bind(key).first<{ id: string }>())!.id;
  }
  const conv = await loadConv(c.env, id, me.user_id);
  return json({ conversation: await convOut(c.env, conv, me, await getSettings(c.env)) });
});

export async function createGroup(
  c: Ctx,
  me: Principal,
  name: string,
  memberIdsIn: string[],
  managed: boolean,
  flags: Partial<ReturnType<typeof defaultsFor>> = {},
  external: { organization: string } | null = null,
) {
  const ids = [...new Set([me.user_id, ...memberIdsIn])].slice(0, 2000);
  const valid = await c.env.DB.prepare(
    `SELECT id, kind, organization, display_name FROM users WHERE status='active' AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<{ id: string; kind: string; organization: string; display_name: string }>();
  const convShape = { external: external ? 1 : 0, organization: external?.organization ?? "" };
  for (const u of valid.results) {
    const j = canJoin(convShape, u);
    if (!j.ok) throw new HttpError(403, "policy_denied", `${u.display_name}: ${j.reason}`);
  }
  const d = { ...defaultsFor("group", managed, !!external), ...flags };
  const id = newId("c");
  const t = now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO conversations(id,kind,name,managed,allow_upload,allow_forward_out,allow_copy,allow_save_file,created_by,created_at,last_msg_at,external,organization,require_approval)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, "group", name, managed ? 1 : 0, d.allow_upload, d.allow_forward_out, d.allow_copy, d.allow_save_file, me.user_id, t, t, convShape.external, convShape.organization, convShape.external),
    ...valid.results.map((u) =>
      c.env.DB.prepare("INSERT INTO members(conversation_id,user_id,role,joined_at) VALUES (?,?,?,?)").bind(
        id,
        u.id,
        u.id === me.user_id ? "owner" : "member",
        t,
      ),
    ),
  ];
  await c.env.DB.batch(stmts);
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: external ? "create_external_group" : managed ? "create_managed_group" : "create_group", conversation_id: id, allowed: true, detail: external ? `${name} [${external.organization}]` : name });
  await insertMessage(c, id, me.user_id, { kind: "system", text: `${me.display_name} đã tạo nhóm "${name}"` });
  fanout(c, valid.results.map((u) => u.id), { type: "conversation_changed", conversation_id: id });
  return id;
}

route("POST", "/api/conversations/group", async (c) => {
  const me = await authenticate(c.env, c.req);
  const settings = await getSettings(c.env);
  const ri = requireInternal(me, "tạo nhóm");
  if (!ri.ok) throw new HttpError(403, "policy_denied", ri.reason);
  if (settings.members_can_create_groups !== "1" && me.role !== "admin")
    throw new HttpError(403, "forbidden", "Chỉ quản trị viên được tạo nhóm");
  const b = await readJson<{ name?: string; member_ids?: string[] }>(c.req);
  const id = await createGroup(c, me, str(b.name, "name", 120), Array.isArray(b.member_ids) ? b.member_ids.map(String) : [], false);
  return json({ conversation: await convOut(c.env, await loadConv(c.env, id, me.user_id), me, settings) });
});

route("GET", "/api/conversations/:id", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const conv = await loadConv(c.env, p.id, me.user_id);
  const members = await c.env.DB.prepare(
    `SELECT u.id, u.display_name, u.department, u.kind, u.organization, m.role FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? ORDER BY u.kind DESC, u.display_name`,
  )
    .bind(p.id)
    .all<{ id: string; display_name: string; department: string; kind: string; organization: string; role: string }>();
  // Người bên ngoài không cần biết sơ đồ phòng ban của công ty.
  const list = members.results.map((m) => ({
    ...m,
    department: me.kind === "external" && m.kind === "internal" ? "" : m.department,
  }));
  return json({ conversation: await convOut(c.env, conv, me, await getSettings(c.env)), members: list });
});

route("GET", "/api/conversations/:id/messages", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  await loadConv(c.env, p.id, me.user_id);
  const limit = Math.min(100, Math.max(1, Number(c.url.searchParams.get("limit") ?? 50)));
  const before = c.url.searchParams.get("before");
  const after = c.url.searchParams.get("after");
  let r;
  if (after) {
    r = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`)
      .bind(p.id, Number(after), limit)
      .all<MsgRow>();
  } else {
    r = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
      .bind(p.id, before ? Number(before) : Number.MAX_SAFE_INTEGER, limit)
      .all<MsgRow>();
    r.results.reverse();
  }
  return json({ messages: r.results.map(msgOut) });
});

route("POST", "/api/conversations/:id/messages", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  await loadConv(c.env, p.id, me.user_id);
  const b = await readJson<{ text?: string; reply_to?: string; client_id?: string }>(c.req);
  const text = str(b.text, "text", 8000);
  const message = await insertMessage(c, p.id, me.user_id, {
    kind: "text",
    text,
    reply_to: typeof b.reply_to === "string" ? b.reply_to : null,
    client_id: typeof b.client_id === "string" ? b.client_id.slice(0, 64) : null,
  });
  return json({ message });
});

route("POST", "/api/conversations/:id/files", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const conv = await loadConv(c.env, p.id, me.user_id);
  const settings = await getSettings(c.env);
  const name = decodeURIComponent(c.req.headers.get("x-file-name") ?? "").trim().slice(0, 255) || "tep";
  const dec = canUpload(conv, settings);
  if (!dec.ok) {
    await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "upload", conversation_id: conv.id, target: name, allowed: false, detail: dec.reason });
    throw new HttpError(403, "policy_denied", dec.reason);
  }
  const max = Number(c.env.MAX_UPLOAD_BYTES || 52428800);
  const len = Number(c.req.headers.get("content-length") ?? 0);
  if (len > max) throw new HttpError(413, "too_large", `Tệp vượt quá ${Math.round(max / 1048576)} MB`);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw new HttpError(400, "empty_file", "Tệp rỗng");
  if (body.byteLength > max) throw new HttpError(413, "too_large", `Tệp vượt quá ${Math.round(max / 1048576)} MB`);
  const mime = (c.req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().slice(0, 100);
  const fileId = newId("f");
  const sha = await sha256Hex(body);
  const key = `${conv.id}/${fileId}`;
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: mime }, customMetadata: { uploader: me.user_id, sha256: sha } });
  await c.env.DB.prepare(
    "INSERT INTO files(id,conversation_id,uploader_id,r2_key,name,mime,size,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(fileId, conv.id, me.user_id, key, name, mime, body.byteLength, sha, now())
    .run();
  const caption = c.url.searchParams.get("caption")?.slice(0, 2000) ?? "";
  if (needsApproval(conv, me, conv.member_role)) {
    // Chưa phải tin nhắn: đối tác không thấy, không mở được tệp cho tới khi được duyệt.
    const aid = newId("a");
    await c.env.DB.prepare("INSERT INTO approvals(id,conversation_id,sender_id,file_id,caption,created_at) VALUES (?,?,?,?,?,?)")
      .bind(aid, conv.id, me.user_id, fileId, caption, now())
      .run();
    await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "upload_pending", conversation_id: conv.id, target: aid, allowed: true, detail: `${name} (${body.byteLength} B, sha256 ${sha}) → chờ duyệt gửi ra: ${conv.organization}` });
    const pending = await pendingOut(c.env, aid);
    // Báo cả các thiết bị khác của chính người gửi.
    await notifyApprovers(c, conv.id, { type: "approval_changed", conversation_id: conv.id, approval: pending }, [me.user_id]);
    return json({ pending }, 202);
  }
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: conv.external ? "upload_external" : "upload", conversation_id: conv.id, target: fileId, allowed: true, detail: `${name} (${body.byteLength} B, sha256 ${sha})${conv.external ? ` → bên ngoài: ${conv.organization}` : ""}` });
  const message = await insertMessage(c, conv.id, me.user_id, {
    kind: mime.startsWith("image/") ? "image" : "file",
    text: caption,
    file_id: fileId,
    client_id: c.url.searchParams.get("client_id")?.slice(0, 64) ?? null,
  });
  return json({ message });
});

route("POST", "/api/conversations/:id/read", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const b = await readJson<{ seq?: number }>(c.req);
  await c.env.DB.prepare(
    "UPDATE members SET last_read_seq = MAX(last_read_seq, MIN(?, (SELECT last_seq FROM conversations WHERE id = ?))) WHERE conversation_id = ? AND user_id = ?",
  )
    .bind(Number(b.seq ?? 0), p.id, p.id, me.user_id)
    .run();
  return json({ ok: true });
});

route("POST", "/api/conversations/:id/members", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const conv = await loadConv(c.env, p.id, me.user_id);
  if (conv.kind !== "group") throw new HttpError(400, "not_group", "Chỉ thêm thành viên vào nhóm");
  const canManage = me.role === "admin" || (!conv.managed && ["owner", "admin"].includes(conv.member_role));
  if (!canManage) throw new HttpError(403, "forbidden", "Bạn không có quyền thêm thành viên");
  const b = await readJson<{ user_ids?: string[] }>(c.req);
  const ids = (Array.isArray(b.user_ids) ? b.user_ids : []).map(String).slice(0, 500);
  if (!ids.length) throw new HttpError(400, "bad_field", "Chưa chọn thành viên");
  await assertCanJoin(c.env, conv, ids);
  const t = now();
  await c.env.DB.batch(
    ids.map((u) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO members(conversation_id,user_id,role,joined_at,last_read_seq) SELECT ?, id, 'member', ?, ? FROM users WHERE id = ? AND status='active'",
      ).bind(p.id, t, conv.last_seq, u),
    ),
  );
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "add_members", conversation_id: p.id, allowed: true, detail: ids.join(",") });
  await fanoutConv(c, p.id, { type: "conversation_changed", conversation_id: p.id });
  return json({ ok: true });
});

route("DELETE", "/api/conversations/:id/members/:uid", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const conv = await loadConv(c.env, p.id, me.user_id);
  if (conv.kind !== "group") throw new HttpError(400, "not_group", "Không áp dụng cho chat 1-1");
  const self = p.uid === me.user_id;
  const canManage = me.role === "admin" || (!conv.managed && ["owner", "admin"].includes(conv.member_role));
  if (!self && !canManage) throw new HttpError(403, "forbidden", "Bạn không có quyền xóa thành viên");
  if (self && conv.managed && me.role !== "admin") throw new HttpError(403, "forbidden", "Không thể tự rời nhóm do công ty quản lý");
  const before = await memberIds(c.env, p.id);
  await c.env.DB.prepare("DELETE FROM members WHERE conversation_id = ? AND user_id = ?").bind(p.id, p.uid).run();
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "remove_member", conversation_id: p.id, target: p.uid, allowed: true });
  fanout(c, before, { type: "conversation_changed", conversation_id: p.id });
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Thao tác trên tin nhắn

route("POST", "/api/messages/:id/forward", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const ri = requireInternal(me, "chuyển tiếp tin nhắn");
  if (!ri.ok) throw new HttpError(403, "policy_denied", ri.reason);
  const msg = await loadMsg(c.env, p.id);
  if (!msg || msg.recalled_at) throw new HttpError(404, "message_not_found", "Không tìm thấy tin nhắn");
  const src = await loadConv(c.env, msg.conversation_id, me.user_id);
  const b = await readJson<{ conversation_id?: string }>(c.req);
  const dst = await loadConv(c.env, str(b.conversation_id, "conversation_id", 64), me.user_id);
  const settings = await getSettings(c.env);
  if (msg.kind === "system") throw new HttpError(400, "bad_message", "Không thể chuyển tiếp tin hệ thống");
  const dec = canForward(src, dst, !!msg.file_id, settings);
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "forward", conversation_id: src.id, target: dst.id, allowed: dec.ok, detail: dec.ok ? msg.id : `${msg.id}: ${dec.reason}` });
  if (!dec.ok) throw new HttpError(403, "policy_denied", dec.reason);
  const message = await insertMessage(c, dst.id, me.user_id, {
    kind: msg.kind,
    text: msg.text,
    file_id: msg.file_id,
    forwarded_from: msg.id,
  });
  return json({ message });
});

route("POST", "/api/messages/:id/recall", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const msg = await loadMsg(c.env, p.id);
  if (!msg) throw new HttpError(404, "message_not_found", "Không tìm thấy tin nhắn");
  await loadConv(c.env, msg.conversation_id, me.user_id);
  const own = msg.sender_id === me.user_id && now() - msg.created_at < 24 * 3600 * 1000;
  if (!own && me.role !== "admin") throw new HttpError(403, "forbidden", "Chỉ thu hồi được tin của mình trong 24 giờ");
  await c.env.DB.prepare("UPDATE messages SET recalled_at = ? WHERE id = ?").bind(now(), msg.id).run();
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "recall", conversation_id: msg.conversation_id, target: msg.id, allowed: true });
  const out = msgOut((await loadMsg(c.env, msg.id))!);
  await fanoutConv(c, msg.conversation_id, { type: "message_updated", message: out });
  return json({ message: out });
});

// ---------------------------------------------------------------------------
// Tệp

route("GET", "/api/files/:id", async (c, p) => {
  const me = await authenticate(c.env, c.req);
  const file = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(p.id).first<{
    id: string;
    r2_key: string;
    name: string;
    mime: string;
    size: number;
  }>();
  if (!file) throw new HttpError(404, "file_not_found", "Không tìm thấy tệp");
  // Có quyền nếu là thành viên của một hội thoại có tin nhắn (chưa thu hồi) chứa tệp này.
  const conv = await c.env.DB.prepare(
    `SELECT c.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       JOIN members mb ON mb.conversation_id = c.id AND mb.user_id = ?
      WHERE m.file_id = ? AND m.recalled_at IS NULL LIMIT 1`,
  )
    .bind(me.user_id, file.id)
    .first<ConvPolicyRow>();
  if (!conv) throw new HttpError(404, "file_not_found", "Không tìm thấy tệp");
  const access = fileAccess(conv, me, await getSettings(c.env));
  const purpose = c.url.searchParams.get("purpose") === "save" ? "save" : "view";
  const allowed = access === "allow" || (access === "view" && purpose === "view");
  await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: purpose === "save" ? "file_save" : "file_view", conversation_id: conv.id, target: file.id, allowed, detail: `${file.name} [${access}]` });
  if (!allowed) throw new HttpError(403, "policy_denied", access === "deny" ? "Thiết bị này không được mở tệp" : "Chỉ được xem, không được lưu tệp này");
  const obj = await c.env.FILES.get(file.r2_key);
  if (!obj) throw new HttpError(404, "file_not_found", "Tệp không còn trên máy chủ");
  return new Response(obj.body, {
    headers: {
      "content-type": file.mime,
      "content-length": String(obj.size),
      "content-disposition": `${purpose === "save" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "cache-control": "private, no-store",
      "x-file-access": access,
      "x-content-type-options": "nosniff",
    },
  });
});

adminRoutes(route);
approvalRoutes(route);

export async function assertCanJoin(env: Env, conv: { external: number; organization: string }, ids: string[]) {
  if (!ids.length) return;
  const r = await env.DB.prepare(`SELECT id, kind, organization, display_name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string; kind: string; organization: string; display_name: string }>();
  for (const u of r.results) {
    const j = canJoin(conv, u);
    if (!j.ok) throw new HttpError(403, "policy_denied", `${u.display_name}: ${j.reason}`);
  }
}
