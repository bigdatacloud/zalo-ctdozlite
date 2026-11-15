// API quản trị: tài khoản, thiết bị, nhóm công ty, chính sách, nhật ký.
import { authenticate, hashPassword, Principal, validatePassword } from "./auth";
import { assertCanJoin, createGroup, fanout, fanoutConv, route as routeFn, usersByIds } from "./index";
import { archiveAudit, archiveMessages } from "./archive";
import { audit, auditDb, bool01, Env, getSettings, HttpError, json, newId, now, readJson, str } from "./util";

type Route = typeof routeFn;

async function requireAdmin(env: Env, req: Request): Promise<Principal> {
  const me = await authenticate(env, req);
  if (me.role !== "admin") throw new HttpError(403, "forbidden", "Cần quyền quản trị");
  return me;
}

export async function revokeUserEverywhere(env: Env, userId: string, reason: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now(), userId),
  ]);
  await env.HUB.get(env.HUB.idFromName(userId)).revoke(null, reason);
}

/** Nhận ngày hết hạn dạng số mili-giây hoặc chuỗi "YYYY-MM-DD" (hết ngày đó, giờ VN). */
function parseExpiry(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "number") return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) throw new HttpError(400, "bad_field", "Ngày hết hạn phải có dạng YYYY-MM-DD");
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T23:59:59+07:00`);
}

const SETTING_KEYS: Record<string, string[]> = {
  dm_upload: ["0", "1"],
  members_can_create_groups: ["0", "1"],
  mobile_untrusted_files: ["allow", "view", "deny"],
  push_content: ["none", "sender"],
  archive_after_days: ["90", "180", "365", "730"],
  audit_keep_days: ["365", "730", "1095", "1825"],
};

export function adminRoutes(route: Route) {
  // Tạo quản trị viên đầu tiên. Chỉ chạy được khi chưa có người dùng nào.
  route("POST", "/api/admin/bootstrap", async (c) => {
    const b = await readJson<{ token?: string; username?: string; display_name?: string; password?: string }>(c.req);
    if (!c.env.ADMIN_BOOTSTRAP_TOKEN || b.token !== c.env.ADMIN_BOOTSTRAP_TOKEN)
      throw new HttpError(403, "forbidden", "Mã khởi tạo không đúng");
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    if ((count?.n ?? 0) > 0) throw new HttpError(409, "already_bootstrapped", "Hệ thống đã được khởi tạo");
    const password = str(b.password, "password", 256);
    validatePassword(password);
    const h = await hashPassword(password);
    const id = newId("u");
    await c.env.DB.prepare(
      "INSERT INTO users(id,username,display_name,role,password_hash,password_salt,must_change_password,created_at) VALUES (?,?,?,?,?,?,0,?)",
    )
      .bind(id, str(b.username, "username", 64), str(b.display_name, "display_name", 120), "admin", h.hash, h.salt, now())
      .run();
    await audit(c.env, { user_id: id, action: "bootstrap", allowed: true });
    return json({ ok: true, user_id: id });
  });

  route("GET", "/api/admin/users", async (c) => {
    await requireAdmin(c.env, c.req);
    const r = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.department, u.role, u.status, u.must_change_password, u.created_at,
              u.kind, u.organization, u.email, u.sponsor_id, s.display_name AS sponsor_name, u.expires_at,
              (SELECT MAX(last_seen) FROM devices d WHERE d.user_id = u.id) AS last_seen
         FROM users u LEFT JOIN users s ON s.id = u.sponsor_id ORDER BY u.kind, u.username`,
    ).all();
    return json({ users: r.results });
  });

  route("POST", "/api/admin/users", async (c) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{
      username?: string;
      display_name?: string;
      department?: string;
      password?: string;
      role?: string;
      kind?: string;
      organization?: string;
      email?: string;
      sponsor_id?: string;
      expires_at?: unknown;
    }>(c.req);
    const kind = b.kind === "external" ? "external" : "internal";
    const organization = kind === "external" ? str(b.organization, "organization (tên đơn vị)", 120) : "";
    if (kind === "external" && b.role === "admin") throw new HttpError(400, "bad_field", "Tài khoản bên ngoài không thể là quản trị viên");
    const expires = parseExpiry(b.expires_at) ?? null;
    const password = str(b.password, "password", 256);
    validatePassword(password);
    const h = await hashPassword(password);
    const id = newId("u");
    const username = str(b.username, "username", 64);
    try {
      await c.env.DB.prepare(
        `INSERT INTO users(id,username,display_name,department,role,password_hash,password_salt,created_at,kind,organization,email,sponsor_id,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          id,
          username,
          str(b.display_name, "display_name", 120),
          (b.department ?? "").slice(0, 120),
          b.role === "admin" ? "admin" : "member",
          h.hash,
          h.salt,
          now(),
          kind,
          organization,
          (b.email ?? "").slice(0, 200),
          b.sponsor_id || me.user_id,
          expires,
        )
        .run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "username_taken", "Mã nhân viên đã tồn tại");
      throw e;
    }
    await audit(c.env, { user_id: me.user_id, action: kind === "external" ? "admin_create_external_user" : "admin_create_user", target: id, allowed: true, detail: kind === "external" ? `${username} [${organization}]` : username });
    return json({ user_id: id });
  });

  route("PATCH", "/api/admin/users/:id", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{ display_name?: string; department?: string; role?: string; status?: string; password?: string; email?: string; expires_at?: unknown; sponsor_id?: string }>(c.req);
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.display_name !== undefined) (sets.push("display_name=?"), vals.push(str(b.display_name, "display_name", 120)));
    if (b.department !== undefined) (sets.push("department=?"), vals.push(String(b.department).slice(0, 120)));
    if (b.role !== undefined) {
      const k = await c.env.DB.prepare("SELECT kind FROM users WHERE id = ?").bind(p.id).first<{ kind: string }>();
      if (b.role === "admin" && k?.kind === "external") throw new HttpError(400, "bad_field", "Tài khoản bên ngoài không thể là quản trị viên");
      sets.push("role=?");
      vals.push(b.role === "admin" ? "admin" : "member");
    }
    if (b.email !== undefined) (sets.push("email=?"), vals.push(String(b.email).slice(0, 200)));
    if (b.sponsor_id !== undefined) (sets.push("sponsor_id=?"), vals.push(String(b.sponsor_id)));
    const exp = parseExpiry(b.expires_at);
    if (exp !== undefined) (sets.push("expires_at=?"), vals.push(exp));
    if (b.status !== undefined) (sets.push("status=?"), vals.push(b.status === "disabled" ? "disabled" : "active"));
    if (b.password !== undefined) {
      validatePassword(b.password);
      const h = await hashPassword(b.password);
      sets.push("password_hash=?", "password_salt=?", "must_change_password=1");
      vals.push(h.hash, h.salt);
    }
    if (!sets.length) throw new HttpError(400, "bad_field", "Không có gì để cập nhật");
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(",")} WHERE id = ?`).bind(...vals, p.id).run();
    if (b.status === "disabled" || b.password !== undefined) await revokeUserEverywhere(c.env, p.id, b.status === "disabled" ? "Tài khoản đã bị khóa" : "Mật khẩu đã được đặt lại");
    await audit(c.env, { user_id: me.user_id, action: "admin_update_user", target: p.id, allowed: true, detail: Object.keys(b).join(",") });
    return json({ ok: true });
  });

  route("GET", "/api/admin/devices", async (c) => {
    await requireAdmin(c.env, c.req);
    const uid = c.url.searchParams.get("user_id");
    const r = await c.env.DB.prepare(
      `SELECT d.id, d.user_id, d.platform, d.name, d.trusted, d.created_at, d.last_seen, d.revoked_at,
              (d.push_token IS NOT NULL) AS has_push, u.username, u.display_name
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE (? IS NULL OR d.user_id = ?) ORDER BY d.last_seen DESC LIMIT 500`,
    )
      .bind(uid, uid)
      .all();
    return json({ devices: r.results });
  });

  route("PATCH", "/api/admin/devices/:id", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{ trusted?: boolean }>(c.req);
    await c.env.DB.prepare("UPDATE devices SET trusted = ? WHERE id = ?").bind(b.trusted ? 1 : 0, p.id).run();
    await audit(c.env, { user_id: me.user_id, action: "admin_trust_device", target: p.id, allowed: true, detail: String(!!b.trusted) });
    return json({ ok: true });
  });

  route("POST", "/api/admin/devices/:id/revoke", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const d = await c.env.DB.prepare("SELECT user_id FROM devices WHERE id = ?").bind(p.id).first<{ user_id: string }>();
    if (!d) throw new HttpError(404, "device_not_found", "Không tìm thấy thiết bị");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(p.id),
      c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(now(), p.id),
    ]);
    await c.env.HUB.get(c.env.HUB.idFromName(d.user_id)).revoke(p.id, "Thiết bị đã bị quản trị viên thu hồi");
    await audit(c.env, { user_id: me.user_id, action: "admin_revoke_device", target: p.id, allowed: true });
    return json({ ok: true });
  });

  // Nhóm do công ty quản lý: chỉ quản trị viên tạo, mặc định cho gửi tệp, cấm chuyển tiếp/sao chép ra ngoài.
  route("POST", "/api/admin/groups", async (c) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{ name?: string; member_ids?: string[]; allow_upload?: boolean; allow_forward_out?: boolean; allow_copy?: boolean; allow_save_file?: boolean; external?: boolean; organization?: string }>(c.req);
    const flags: Record<string, 0 | 1> = {};
    for (const k of ["allow_upload", "allow_forward_out", "allow_copy", "allow_save_file"] as const) {
      const v = bool01(b[k]);
      if (v !== undefined) flags[k] = v;
    }
    const external = b.external ? { organization: str(b.organization, "organization (tên đơn vị)", 120) } : null;
    const id = await createGroup(c, me, str(b.name, "name", 120), Array.isArray(b.member_ids) ? b.member_ids.map(String) : [], true, flags, external);
    return json({ conversation_id: id });
  });

  route("GET", "/api/admin/conversations", async (c) => {
    await requireAdmin(c.env, c.req);
    const r = await c.env.DB.prepare(
      `SELECT c.id, c.kind, c.name, c.managed, c.external, c.organization, c.require_approval, c.allow_upload, c.allow_forward_out, c.allow_copy, c.allow_save_file,
              c.created_by, c.created_at, c.last_msg_at, (SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id) AS member_count
         FROM conversations c WHERE c.kind = 'group' ORDER BY c.last_msg_at DESC LIMIT 1000`,
    ).all();
    return json({ conversations: r.results });
  });

  route("PATCH", "/api/admin/conversations/:id", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<Record<string, unknown>>(c.req);
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.name !== undefined) (sets.push("name=?"), vals.push(str(b.name, "name", 120)));
    for (const k of ["managed", "allow_upload", "allow_forward_out", "allow_copy", "allow_save_file", "require_approval"]) {
      const v = bool01(b[k]);
      if (v !== undefined) (sets.push(`${k}=?`), vals.push(v));
    }
    if (!sets.length) throw new HttpError(400, "bad_field", "Không có gì để cập nhật");
    await c.env.DB.prepare(`UPDATE conversations SET ${sets.join(",")} WHERE id = ?`).bind(...vals, p.id).run();
    await audit(c.env, { user_id: me.user_id, action: "admin_update_conversation", conversation_id: p.id, allowed: true, detail: JSON.stringify(b) });
    await fanoutConv(c, p.id, { type: "conversation_changed", conversation_id: p.id });
    return json({ ok: true });
  });

  route("POST", "/api/admin/conversations/:id/members", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{ user_ids?: string[]; role?: string }>(c.req);
    const ids = (Array.isArray(b.user_ids) ? b.user_ids : []).map(String).slice(0, 2000);
    const conv = await c.env.DB.prepare("SELECT external, organization FROM conversations WHERE id = ? AND kind = 'group'")
      .bind(p.id)
      .first<{ external: number; organization: string }>();
    if (!conv) throw new HttpError(404, "conversation_not_found", "Không tìm thấy nhóm");
    await assertCanJoin(c.env, conv, ids);
    const t = now();
    await c.env.DB.batch(
      ids.map((u) =>
        c.env.DB.prepare(
          `INSERT INTO members(conversation_id,user_id,role,joined_at,last_read_seq)
           SELECT ?, id, ?, ?, (SELECT last_seq FROM conversations WHERE id = ?) FROM users WHERE id = ? AND status='active'
           ON CONFLICT(conversation_id,user_id) DO UPDATE SET role = excluded.role`,
        ).bind(p.id, b.role === "admin" ? "admin" : "member", t, p.id, u),
      ),
    );
    await audit(c.env, { user_id: me.user_id, action: "admin_add_members", conversation_id: p.id, allowed: true, detail: ids.join(",") });
    fanout(c, ids, { type: "conversation_changed", conversation_id: p.id });
    await fanoutConv(c, p.id, { type: "conversation_changed", conversation_id: p.id });
    return json({ ok: true });
  });

  route("GET", "/api/admin/conversations/:id/members", async (c, p) => {
    await requireAdmin(c.env, c.req);
    const r = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.department, u.kind, u.organization, m.role, m.joined_at
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY u.kind DESC, u.display_name`,
    )
      .bind(p.id)
      .all();
    return json({ members: r.results });
  });

  // Đặt/bỏ quyền duyệt (phó nhóm) cho một nhân viên trong nhóm.
  route("PATCH", "/api/admin/conversations/:id/members/:uid", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{ role?: string }>(c.req);
    const role = b.role === "admin" ? "admin" : "member";
    if (role === "admin") {
      const u = await c.env.DB.prepare("SELECT kind FROM users WHERE id = ?").bind(p.uid).first<{ kind: string }>();
      if (u?.kind !== "internal") throw new HttpError(400, "bad_field", "Chỉ nhân viên công ty mới được giao quyền duyệt");
    }
    const r = await c.env.DB.prepare("UPDATE members SET role = ? WHERE conversation_id = ? AND user_id = ? AND role != 'owner'")
      .bind(role, p.id, p.uid)
      .run();
    if (!r.meta.changes) throw new HttpError(404, "not_found", "Không tìm thấy thành viên (hoặc là trưởng nhóm)");
    await audit(c.env, { user_id: me.user_id, action: "admin_set_approver", conversation_id: p.id, target: p.uid, allowed: true, detail: role });
    await fanoutConv(c, p.id, { type: "conversation_changed", conversation_id: p.id });
    return json({ ok: true });
  });

  route("DELETE", "/api/admin/conversations/:id/members/:uid", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const before = (await c.env.DB.prepare("SELECT user_id FROM members WHERE conversation_id = ?").bind(p.id).all<{ user_id: string }>()).results.map((x) => x.user_id);
    await c.env.DB.prepare("DELETE FROM members WHERE conversation_id = ? AND user_id = ?").bind(p.id, p.uid).run();
    await audit(c.env, { user_id: me.user_id, action: "admin_remove_member", conversation_id: p.id, target: p.uid, allowed: true });
    fanout(c, before, { type: "conversation_changed", conversation_id: p.id });
    return json({ ok: true });
  });

  // Chạy lưu trữ ngay (bình thường chạy tự động lúc 02:17 hằng ngày).
  route("POST", "/api/admin/maintenance/archive", async (c) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<{ messages_older_than_days?: number; audit_older_than_days?: number }>(c.req);
    const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
    const messages = await archiveMessages(c.env, n(b.messages_older_than_days));
    const auditRows = await archiveAudit(c.env, n(b.audit_older_than_days));
    await audit(c.env, { user_id: me.user_id, action: "admin_archive", allowed: true, detail: `${messages} tin, ${auditRows} dòng nhật ký` });
    return json({ messages, audit: auditRows });
  });

  route("GET", "/api/admin/audit-archives", async (c) => {
    await requireAdmin(c.env, c.req);
    const list = await c.env.FILES.list({ prefix: "archive/audit/", limit: 1000 });
    return json({ archives: list.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.getTime() })) });
  });

  route("GET", "/api/admin/audit-archives/file", async (c) => {
    const me = await requireAdmin(c.env, c.req);
    const key = c.url.searchParams.get("key") ?? "";
    if (!key.startsWith("archive/audit/")) throw new HttpError(400, "bad_field", "Khóa không hợp lệ");
    const obj = await c.env.FILES.get(key);
    if (!obj) throw new HttpError(404, "not_found", "Không tìm thấy");
    await audit(c.env, { user_id: me.user_id, action: "admin_download_audit_archive", target: key, allowed: true });
    return new Response(obj.body, {
      headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${key.split("/").pop()}"`, "cache-control": "no-store" },
    });
  });

  route("GET", "/api/admin/settings", async (c) => {
    await requireAdmin(c.env, c.req);
    return json({ settings: await getSettings(c.env) });
  });

  route("PATCH", "/api/admin/settings", async (c) => {
    const me = await requireAdmin(c.env, c.req);
    const b = await readJson<Record<string, unknown>>(c.req);
    const stmts = [];
    for (const [k, v] of Object.entries(b)) {
      if (!SETTING_KEYS[k] || !SETTING_KEYS[k].includes(String(v))) throw new HttpError(400, "bad_field", `Giá trị không hợp lệ cho ${k}`);
      stmts.push(c.env.DB.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, String(v)));
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    await audit(c.env, { user_id: me.user_id, action: "admin_settings", allowed: true, detail: JSON.stringify(b) });
    return json({ settings: await getSettings(c.env) });
  });

  route("GET", "/api/admin/audit", async (c) => {
    await requireAdmin(c.env, c.req);
    const q = c.url.searchParams;
    const r = await auditDb(c.env)
      .prepare(
        `SELECT * FROM audit
          WHERE (?1 IS NULL OR user_id = ?1) AND (?2 IS NULL OR action = ?2) AND (?3 IS NULL OR allowed = ?3)
            AND (?4 IS NULL OR id < ?4)
          ORDER BY id DESC LIMIT ?5`,
      )
      .bind(q.get("user_id"), q.get("action"), q.get("allowed") === null ? null : Number(q.get("allowed")), q.get("before_id") ? Number(q.get("before_id")) : null, Math.min(500, Number(q.get("limit") ?? 100)))
      .all<{ user_id: string | null }>();
    // Nhật ký nằm ở DB riêng: tra tên người dùng ở DB chính.
    const names = new Map((await usersByIds(c.env, [...new Set(r.results.map((a) => a.user_id).filter((x): x is string => !!x))])).map((u) => [u.id, u]));
    return json({
      audit: r.results.map((a) => ({ ...a, username: names.get(a.user_id ?? "")?.username ?? null, display_name: names.get(a.user_id ?? "")?.display_name ?? null })),
    });
  });

  // Kiểm tra quyền xem một hội thoại bất kỳ (phục vụ điều tra rò rỉ). Mỗi lần xem đều bị ghi nhật ký.
  route("GET", "/api/admin/conversations/:id/messages", async (c, p) => {
    const me = await requireAdmin(c.env, c.req);
    const reason = c.url.searchParams.get("reason") ?? "";
    if (reason.trim().length < 5) throw new HttpError(400, "reason_required", "Phải ghi lý do khi xem hội thoại của người khác");
    await audit(c.env, { user_id: me.user_id, action: "admin_read_conversation", conversation_id: p.id, allowed: true, detail: reason });
    const r = await c.env.DB.prepare(
      `SELECT m.id, m.seq, m.sender_id, u.display_name AS sender_name, m.kind, m.text, m.file_id, m.forwarded_from, m.created_at, m.recalled_at
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? ORDER BY m.seq DESC LIMIT 200`,
    )
      .bind(p.id)
      .all();
    return json({ messages: r.results });
  });

}

/** Chạy định kỳ: tài khoản hết hạn còn thiết bị đang mở thì thu hồi và yêu cầu xóa dữ liệu. */
export async function sweepExpired(env: Env) {
  const r = await env.DB.prepare(
    `SELECT DISTINCT u.id FROM users u JOIN devices d ON d.user_id = u.id
      WHERE u.expires_at IS NOT NULL AND u.expires_at < ? AND d.revoked_at IS NULL`,
  )
    .bind(now())
    .all<{ id: string }>();
  for (const u of r.results) {
    await revokeUserEverywhere(env, u.id, "Tài khoản đã hết hạn sử dụng");
    await audit(env, { user_id: u.id, action: "expire_sweep", allowed: true });
  }
  return r.results.length;
}
