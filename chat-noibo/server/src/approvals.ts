// Duyệt tệp gửi ra bên ngoài.
//
// Nhân viên không có quyền duyệt gửi tệp vào nhóm có người bên ngoài -> tệp nằm ở bảng
// `approvals` (chưa là tin nhắn). Đối tác không thấy, không mở được. Người duyệt (quản trị
// viên hệ thống hoặc trưởng/phó nhóm do IT chỉ định) bấm duyệt thì tệp mới thành tin nhắn
// trong nhóm, đứng tên người gửi ban đầu. Mọi bước đều ghi nhật ký.
import { authenticate, Principal } from "./auth";
import type { Ctx, ConvRow, Handler } from "./index";
import { fanout, insertMessage } from "./index";
import { isApprover } from "./policy";
import { pushToUsers } from "./push";
import { audit, Env, HttpError, json, now, readJson } from "./util";

type Route = (method: string, path: string, h: Handler) => void;

interface ApprovalRow {
  id: string;
  conversation_id: string;
  conversation_name: string;
  organization: string;
  sender_id: string;
  sender_name: string;
  sender_username: string;
  file_id: string;
  file_name: string;
  file_mime: string;
  file_size: number;
  file_sha256: string;
  caption: string;
  status: string;
  created_at: number;
  decided_by: string | null;
  decider_name: string | null;
  decided_at: number | null;
  reason: string;
  message_id: string | null;
}

const SELECT = `SELECT a.*, c.name AS conversation_name, c.organization, s.display_name AS sender_name, s.username AS sender_username,
    f.name AS file_name, f.mime AS file_mime, f.size AS file_size, f.sha256 AS file_sha256, d.display_name AS decider_name
  FROM approvals a JOIN conversations c ON c.id = a.conversation_id JOIN users s ON s.id = a.sender_id
  JOIN files f ON f.id = a.file_id LEFT JOIN users d ON d.id = a.decided_by`;

function out(r: ApprovalRow) {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    conversation_name: r.conversation_name,
    organization: r.organization,
    sender_id: r.sender_id,
    sender_name: r.sender_name,
    sender_username: r.sender_username,
    file: { id: r.file_id, name: r.file_name, mime: r.file_mime, size: r.file_size, sha256: r.file_sha256 },
    caption: r.caption,
    status: r.status,
    created_at: r.created_at,
    decided_by_name: r.decider_name,
    decided_at: r.decided_at,
    reason: r.reason,
    message_id: r.message_id,
  };
}

export async function pendingOut(env: Env, id: string) {
  const r = await env.DB.prepare(`${SELECT} WHERE a.id = ?`).bind(id).first<ApprovalRow>();
  return r ? out(r) : null;
}

async function loadConvFor(env: Env, convId: string, userId: string) {
  return env.DB.prepare(
    `SELECT c.*, m.role AS member_role, m.last_read_seq FROM conversations c
       LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.id = ?`,
  )
    .bind(userId, convId)
    .first<ConvRow & { member_role: string | null }>();
}

/** Danh sách người được báo khi có tệp chờ duyệt trong một nhóm. */
async function approverIds(env: Env, convId: string): Promise<string[]> {
  const r = await env.DB.prepare(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active'
     UNION
     SELECT u.id FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.role IN ('owner','admin') AND u.kind = 'internal' AND u.status = 'active'`,
  )
    .bind(convId)
    .all<{ id: string }>();
  return r.results.map((x) => x.id);
}

export async function notifyApprovers(c: Ctx, convId: string, event: unknown, alsoUserIds: string[] = []) {
  const approvers = await approverIds(c.env, convId);
  const ids = new Set([...approvers, ...alsoUserIds]);
  fanout(c, [...ids], event);
  // Thông báo đẩy: người duyệt khi có tệp mới chờ; người gửi khi có quyết định.
  const a = (event as { approval?: { status: string; sender_id: string; conversation_name: string; organization: string } | null }).approval;
  if (!a) return;
  const data = { type: "approval", conversation_id: convId };
  if (a.status === "pending") {
    c.exec.waitUntil(
      pushToUsers(c.env, approvers.filter((u) => u !== a.sender_id), {
        title: "Tệp chờ bạn duyệt",
        body: `Gửi ra ${a.organization} · ${a.conversation_name}`,
        data,
        collapse: `approval-${convId}`,
      }).catch((e) => console.error("push", e)),
    );
  } else if (a.status === "approved" || a.status === "rejected") {
    c.exec.waitUntil(
      pushToUsers(c.env, [a.sender_id], {
        title: a.status === "approved" ? "Tệp đã được duyệt" : "Tệp bị từ chối",
        body: a.conversation_name,
        data,
        collapse: `approval-${convId}`,
      }).catch((e) => console.error("push", e)),
    );
  }
}

async function requireApproverOf(env: Env, me: Principal, convId: string) {
  const conv = await loadConvFor(env, convId, me.user_id);
  if (!conv) throw new HttpError(404, "conversation_not_found", "Không tìm thấy nhóm");
  if (!isApprover(me, conv.member_role)) throw new HttpError(403, "forbidden", "Bạn không có quyền duyệt tệp của nhóm này");
  return conv;
}

export function approvalRoutes(route: Route) {
  // Danh sách chờ duyệt mà tôi có quyền xử lý (quản trị viên: toàn công ty).
  route("GET", "/api/approvals", async (c) => {
    const me = await authenticate(c.env, c.req);
    if (me.kind !== "internal") throw new HttpError(403, "forbidden", "Không có quyền");
    const status = c.url.searchParams.get("status") ?? "pending";
    const limit = Math.min(200, Number(c.url.searchParams.get("limit") ?? 100));
    const where = status === "all" ? "1=1" : "a.status = ?1";
    const scope =
      me.role === "admin"
        ? "1=1"
        : "a.conversation_id IN (SELECT conversation_id FROM members WHERE user_id = ?2 AND role IN ('owner','admin'))";
    const r = await c.env.DB.prepare(`${SELECT} WHERE ${where} AND ${scope} ORDER BY a.created_at DESC LIMIT ?3`)
      .bind(status, me.user_id, limit)
      .all<ApprovalRow>();
    return json({ approvals: r.results.map(out) });
  });

  // Trong một nhóm: người duyệt thấy mọi tệp chờ; người gửi thấy tệp của mình (cả bị từ chối gần đây).
  route("GET", "/api/conversations/:id/pending", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const conv = await loadConvFor(c.env, p.id, me.user_id);
    if (!conv || (!conv.member_role && me.role !== "admin")) throw new HttpError(404, "conversation_not_found", "Không tìm thấy nhóm");
    if (me.kind !== "internal") return json({ approvals: [] });
    const approver = isApprover(me, conv.member_role);
    const since = now() - 7 * 24 * 3600 * 1000;
    const r = await c.env.DB.prepare(
      `${SELECT} WHERE a.conversation_id = ?1 AND (
         (a.status = 'pending' AND (?2 = 1 OR a.sender_id = ?3))
         OR (a.status = 'rejected' AND a.sender_id = ?3 AND a.decided_at > ?4))
       ORDER BY a.created_at`,
    )
      .bind(p.id, approver ? 1 : 0, me.user_id, since)
      .all<ApprovalRow>();
    return json({ approvals: r.results.map(out) });
  });

  // Người duyệt hoặc người gửi xem trước tệp đang chờ.
  route("GET", "/api/approvals/:id/file", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const a = await pendingOut(c.env, p.id);
    if (!a) throw new HttpError(404, "not_found", "Không tìm thấy");
    if (a.sender_id !== me.user_id) await requireApproverOf(c.env, me, a.conversation_id);
    const f = await c.env.DB.prepare("SELECT r2_key FROM files WHERE id = ?").bind(a.file.id).first<{ r2_key: string }>();
    const obj = f && (await c.env.FILES.get(f.r2_key));
    if (!obj) throw new HttpError(404, "file_not_found", "Tệp không còn trên máy chủ");
    await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "approval_preview", conversation_id: a.conversation_id, target: a.id, allowed: true, detail: a.file.name });
    return new Response(obj.body, {
      headers: {
        "content-type": a.file.mime,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.file.name)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  const decide = (approve: boolean): Handler => async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const a = await pendingOut(c.env, p.id);
    if (!a) throw new HttpError(404, "not_found", "Không tìm thấy yêu cầu duyệt");
    await requireApproverOf(c.env, me, a.conversation_id);
    const b = approve ? {} : await readJson<{ reason?: string }>(c.req);
    const reason = String((b as { reason?: string }).reason ?? "").trim().slice(0, 500);
    if (!approve && reason.length < 3) throw new HttpError(400, "reason_required", "Ghi lý do từ chối để người gửi biết");
    // Chỉ một người duyệt thắng nếu hai người bấm cùng lúc.
    const upd = await c.env.DB.prepare(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'",
    )
      .bind(approve ? "approved" : "rejected", me.user_id, now(), reason, a.id)
      .run();
    if (!upd.meta.changes) throw new HttpError(409, "already_decided", "Yêu cầu này đã được xử lý");
    let message = null;
    if (approve) {
      // Người gửi có thể đã bị đưa ra khỏi nhóm trong lúc chờ: vẫn gửi đứng tên họ vì nội dung là của họ,
      // người duyệt là người chịu trách nhiệm cho quyết định đưa ra ngoài.
      message = await insertMessage(c, a.conversation_id, a.sender_id, {
        kind: a.file.mime.startsWith("image/") ? "image" : "file",
        text: a.caption,
        file_id: a.file.id,
      });
      await c.env.DB.prepare("UPDATE approvals SET message_id = ? WHERE id = ?").bind(message.id, a.id).run();
    }
    await audit(c.env, {
      user_id: me.user_id,
      device_id: me.device_id,
      action: approve ? "approve_external" : "reject_external",
      conversation_id: a.conversation_id,
      target: a.id,
      allowed: true,
      detail: `${a.file.name} của ${a.sender_name} → ${a.organization}${approve ? "" : `: ${reason}`}`,
    });
    const updated = await pendingOut(c.env, a.id);
    await notifyApprovers(c, a.conversation_id, { type: "approval_changed", conversation_id: a.conversation_id, approval: updated }, [a.sender_id]);
    return json({ approval: updated, message });
  };
  route("POST", "/api/approvals/:id/approve", decide(true));
  route("POST", "/api/approvals/:id/reject", decide(false));

  // Người gửi rút lại khi chưa ai duyệt.
  route("POST", "/api/approvals/:id/cancel", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const a = await pendingOut(c.env, p.id);
    if (!a || a.sender_id !== me.user_id) throw new HttpError(404, "not_found", "Không tìm thấy");
    const upd = await c.env.DB.prepare("UPDATE approvals SET status='cancelled', decided_at=? WHERE id=? AND status='pending'").bind(now(), a.id).run();
    if (!upd.meta.changes) throw new HttpError(409, "already_decided", "Yêu cầu này đã được xử lý");
    await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "cancel_external", conversation_id: a.conversation_id, target: a.id, allowed: true, detail: a.file.name });
    const updated = await pendingOut(c.env, a.id);
    await notifyApprovers(c, a.conversation_id, { type: "approval_changed", conversation_id: a.conversation_id, approval: updated }, [a.sender_id]);
    return json({ approval: updated });
  });
}
