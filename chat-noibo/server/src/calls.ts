// Gọi thoại 1-1 qua WebRTC.
//
// Luồng: người gọi POST /api/calls -> người nhận đổ chuông trên mọi thiết bị (WebSocket +
// thông báo đẩy) -> một thiết bị bấm Nghe (POST accept) -> người gọi tạo offer, hai bên trao
// đổi SDP/ICE qua POST signal (máy chủ chuyển tiếp đúng thiết bị) -> âm thanh đi trực tiếp
// giữa hai máy, hoặc qua TURN của Cloudflare khi mạng 4G/NAT không cho đi thẳng.
//
// Chính sách: chỉ gọi trong chat 1-1 giữa nhân viên (người bên ngoài không có chat 1-1).
// Không ghi âm; nhật ký chỉ ghi ai gọi ai, lúc nào, bao lâu.
import { authenticate, Principal } from "./auth";
import type { Ctx, Handler } from "./index";
import { fanout, insertMessage } from "./index";
import { pushToUsers } from "./push";
import { audit, Env, getSettings, HttpError, json, newId, now, readJson, str } from "./util";

type Route = (method: string, path: string, h: Handler) => void;

const RING_TIMEOUT_MS = 60_000;
const MAX_CALL_MS = 4 * 3600_000;
/** Không nhận nhịp từ một đầu quá thời gian này thì coi như rớt máy (ứng dụng gửi mỗi 15 giây). */
const staleMs = (env: Env) => Number(env.CALL_STALE_MS || 45_000);

interface CallRow {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  caller_device: string;
  callee_device: string | null;
  state: "ringing" | "active" | "ended";
  end_reason: string | null;
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
  caller_name?: string;
  callee_name?: string;
}

const SELECT = `SELECT k.*, a.display_name AS caller_name, b.display_name AS callee_name
  FROM calls k JOIN users a ON a.id = k.caller_id JOIN users b ON b.id = k.callee_id`;

async function loadCall(env: Env, id: string) {
  return env.DB.prepare(`${SELECT} WHERE k.id = ?`).bind(id).first<CallRow>();
}

function out(k: CallRow) {
  return {
    id: k.id,
    conversation_id: k.conversation_id,
    caller_id: k.caller_id,
    caller_name: k.caller_name,
    callee_id: k.callee_id,
    callee_name: k.callee_name,
    caller_device: k.caller_device,
    callee_device: k.callee_device,
    state: k.state,
    end_reason: k.end_reason,
    created_at: k.created_at,
    answered_at: k.answered_at,
    ended_at: k.ended_at,
  };
}

function requireParty(k: CallRow | null, me: Principal): CallRow {
  if (!k || (k.caller_id !== me.user_id && k.callee_id !== me.user_id)) throw new HttpError(404, "call_not_found", "Không tìm thấy cuộc gọi");
  return k;
}

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} phút ${s % 60} giây` : `${s} giây`;
}

/** Kết thúc cuộc gọi (một lần duy nhất), ghi tin hệ thống vào chat 1-1 và báo cả hai bên. */
async function finish(c: Ctx, k: CallRow, reason: string, by: Principal | null) {
  const t = now();
  const r = await c.env.DB.prepare("UPDATE calls SET state = 'ended', end_reason = ?, ended_at = ? WHERE id = ? AND state != 'ended'")
    .bind(reason, t, k.id)
    .run();
  if (!r.meta.changes) return (await loadCall(c.env, k.id))!;
  const ended = (await loadCall(c.env, k.id))!;
  const talked = k.answered_at ? t - k.answered_at : 0;
  const text = k.answered_at
    ? `📞 Cuộc gọi thoại · ${fmtDuration(talked)}${reason === "dropped" ? " (mất kết nối)" : ""}`
    : reason === "reject"
      ? `📞 ${k.callee_name} đã từ chối cuộc gọi`
      : reason === "busy"
        ? `📞 Cuộc gọi nhỡ (${k.callee_name} đang bận)`
        : `📞 Cuộc gọi nhỡ từ ${k.caller_name}`;
  await insertMessage(c, k.conversation_id, k.caller_id, { kind: "system", text });
  await audit(c.env, {
    user_id: by?.user_id ?? null,
    device_id: by?.device_id ?? null,
    action: "call_end",
    conversation_id: k.conversation_id,
    target: k.id,
    allowed: true,
    detail: `${k.caller_name} → ${k.callee_name}: ${reason}${k.answered_at ? `, ${fmtDuration(talked)}` : ", không nghe máy"}`,
  });
  fanout(c, [k.caller_id, k.callee_id], { type: "call", event: "ended", call: out(ended) });
  if (!k.answered_at && reason !== "cancel") {
    c.exec.waitUntil(
      pushToUsers(c.env, [k.callee_id], {
        title: "Cuộc gọi nhỡ",
        body: k.caller_name ?? "",
        data: { type: "message", conversation_id: k.conversation_id },
        collapse: `call-${k.id}`,
      }).catch(() => {}),
    );
  }
  return ended;
}

/** Cuộc gọi đổ chuông quá lâu hoặc treo quá 4 giờ (máy mất mạng giữa chừng): đóng lại. */
export async function sweepCalls(c: Ctx) {
  const t = now();
  const stale = t - staleMs(c.env);
  const r = await c.env.DB.prepare(
    `${SELECT} WHERE (k.state = 'ringing' AND (k.created_at < ?1 OR k.caller_seen < ?3))
                 OR (k.state = 'active' AND (k.answered_at < ?2 OR k.caller_seen < ?3 OR k.callee_seen < ?3))`,
  )
    .bind(t - RING_TIMEOUT_MS, t - MAX_CALL_MS, stale)
    .all<CallRow & { caller_seen: number | null; callee_seen: number | null }>();
  for (const k of r.results) {
    const reason =
      k.state === "ringing" ? ((k.caller_seen ?? t) < stale ? "cancel" : "timeout") : k.answered_at! < t - MAX_CALL_MS ? "stale" : "dropped";
    await finish(c, k, reason, null);
  }
}

export function callRoutes(route: Route) {
  // Danh sách máy chủ STUN/TURN cho WebRTC. Có khóa TURN của Cloudflare thì cấp thông tin
  // đăng nhập ngắn hạn; chưa có thì chỉ STUN (gọi được trong cùng mạng/đa số Wi-Fi, 4G có thể lỗi).
  route("GET", "/api/calls/ice-servers", async (c) => {
    await authenticate(c.env, c.req);
    const stunOnly = { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], turn: false };
    if (!c.env.TURN_KEY_ID || !c.env.TURN_KEY_API_TOKEN) return json(stunOnly);
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${c.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    }).catch(() => null);
    if (!res || !res.ok) return json(stunOnly);
    const d = (await res.json()) as { iceServers: { urls: string[] | string; username?: string; credential?: string }[] };
    // Cổng 53 hay bị trình duyệt/mạng chặn và làm chậm việc dò đường: bỏ đi.
    const iceServers = d.iceServers.map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !u.includes(":53")) }));
    return json({ iceServers, turn: true });
  });

  route("GET", "/api/calls/active", async (c) => {
    const me = await authenticate(c.env, c.req);
    const k = await c.env.DB.prepare(`${SELECT} WHERE (k.caller_id = ?1 OR k.callee_id = ?1) AND k.state != 'ended' ORDER BY k.created_at DESC LIMIT 1`)
      .bind(me.user_id)
      .first<CallRow>();
    if (k && k.state === "ringing" && now() - k.created_at > RING_TIMEOUT_MS) {
      await finish(c, k, "timeout", null);
      return json({ call: null });
    }
    return json({ call: k ? out(k) : null });
  });

  route("POST", "/api/calls", async (c) => {
    const me = await authenticate(c.env, c.req);
    const settings = await getSettings(c.env);
    if (settings.calls_enabled === "0") throw new HttpError(403, "policy_denied", "Chức năng gọi thoại đang tắt");
    if (me.kind !== "internal") throw new HttpError(403, "policy_denied", "Tài khoản bên ngoài không gọi thoại được");
    const b = await readJson<{ conversation_id?: string }>(c.req);
    const convId = str(b.conversation_id, "conversation_id", 64);
    const peer = await c.env.DB.prepare(
      `SELECT u.id, u.kind, u.status FROM conversations cv
         JOIN members me ON me.conversation_id = cv.id AND me.user_id = ?1
         JOIN members p ON p.conversation_id = cv.id AND p.user_id != ?1
         JOIN users u ON u.id = p.user_id
        WHERE cv.id = ?2 AND cv.kind = 'dm'`,
    )
      .bind(me.user_id, convId)
      .first<{ id: string; kind: string; status: string }>();
    if (!peer) throw new HttpError(403, "policy_denied", "Chỉ gọi được trong tin nhắn 1-1");
    if (peer.status !== "active" || peer.kind !== "internal") throw new HttpError(403, "policy_denied", "Không gọi được cho người này");

    // Dọn cuộc gọi treo của hai người trước khi kiểm tra bận.
    await sweepCalls(c);
    const busy = await c.env.DB.prepare("SELECT id FROM calls WHERE state != 'ended' AND (caller_id IN (?1, ?2) OR callee_id IN (?1, ?2)) LIMIT 1")
      .bind(me.user_id, peer.id)
      .first<{ id: string }>();
    const id = newId("call");
    await c.env.DB.prepare(
      "INSERT INTO calls(id,conversation_id,caller_id,callee_id,caller_device,state,created_at,caller_seen) VALUES (?,?,?,?,?,'ringing',?,?)",
    )
      .bind(id, convId, me.user_id, peer.id, me.device_id, now(), now())
      .run();
    const k = (await loadCall(c.env, id))!;
    await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "call_start", conversation_id: convId, target: id, allowed: true, detail: `${k.caller_name} → ${k.callee_name}` });
    if (busy) {
      const ended = await finish(c, k, "busy", me);
      return json({ call: out(ended) }, 409);
    }
    fanout(c, [peer.id, me.user_id], { type: "call", event: "ringing", call: out(k) });
    c.exec.waitUntil(
      pushToUsers(c.env, [peer.id], {
        title: "Cuộc gọi đến",
        body: `${k.caller_name} đang gọi cho bạn`,
        data: { type: "call", call_id: id, conversation_id: convId },
        collapse: `call-${id}`,
      }).catch(() => {}),
    );
    return json({ call: out(k) });
  });

  route("POST", "/api/calls/:id/accept", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const k = requireParty(await loadCall(c.env, p.id), me);
    if (k.callee_id !== me.user_id) throw new HttpError(403, "forbidden", "Chỉ người được gọi mới nghe máy");
    // Chỉ một thiết bị thắng nếu người nhận bấm Nghe trên hai máy cùng lúc.
    const r = await c.env.DB.prepare(
      "UPDATE calls SET state = 'active', answered_at = ?1, callee_device = ?2, callee_seen = ?1, caller_seen = ?1 WHERE id = ?3 AND state = 'ringing'",
    )
      .bind(now(), me.device_id, k.id)
      .run();
    if (!r.meta.changes) throw new HttpError(409, "call_not_ringing", "Cuộc gọi đã kết thúc hoặc đã được nghe ở thiết bị khác");
    const active = (await loadCall(c.env, k.id))!;
    await audit(c.env, { user_id: me.user_id, device_id: me.device_id, action: "call_accept", conversation_id: k.conversation_id, target: k.id, allowed: true });
    fanout(c, [k.caller_id, k.callee_id], { type: "call", event: "accepted", call: out(active) });
    return json({ call: out(active) });
  });

  // Nhịp "còn sống" (ứng dụng gửi mỗi 15 giây trong lúc gọi). Trả về trạng thái để ứng dụng
  // tự đóng nếu đầu kia đã rớt.
  route("POST", "/api/calls/:id/heartbeat", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const k = requireParty(await loadCall(c.env, p.id), me);
    if (k.state !== "ended") {
      const col = me.user_id === k.caller_id && me.device_id === k.caller_device ? "caller_seen" : me.device_id === k.callee_device ? "callee_seen" : null;
      if (col) await c.env.DB.prepare(`UPDATE calls SET ${col} = ? WHERE id = ?`).bind(now(), k.id).run();
      await sweepCalls(c);
    }
    return json({ call: out((await loadCall(c.env, k.id))!) });
  });

  // Chuyển SDP/ICE tới đúng thiết bị bên kia.
  route("POST", "/api/calls/:id/signal", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const k = requireParty(await loadCall(c.env, p.id), me);
    if (k.state !== "active") throw new HttpError(409, "call_not_active", "Cuộc gọi chưa được nghe hoặc đã kết thúc");
    const fromCaller = me.user_id === k.caller_id && me.device_id === k.caller_device;
    const fromCallee = me.user_id === k.callee_id && me.device_id === k.callee_device;
    if (!fromCaller && !fromCallee) throw new HttpError(403, "forbidden", "Thiết bị này không tham gia cuộc gọi");
    const b = await readJson<{ kind?: string; data?: unknown }>(c.req);
    if (!["offer", "answer", "ice"].includes(String(b.kind))) throw new HttpError(400, "bad_field", "kind phải là offer/answer/ice");
    if (JSON.stringify(b.data ?? null).length > 64_000) throw new HttpError(413, "too_large", "Tín hiệu quá lớn");
    fanout(c, [fromCaller ? k.callee_id : k.caller_id], {
      type: "call",
      event: "signal",
      call_id: k.id,
      to_device: fromCaller ? k.callee_device : k.caller_device,
      kind: b.kind,
      data: b.data,
    });
    return json({ ok: true });
  });

  // Kết thúc: hangup (đang nói), cancel (người gọi hủy khi đổ chuông), reject (người nhận từ chối),
  // timeout (không ai nghe), failed (không kết nối được).
  route("POST", "/api/calls/:id/end", async (c, p) => {
    const me = await authenticate(c.env, c.req);
    const k = requireParty(await loadCall(c.env, p.id), me);
    const b = await readJson<{ reason?: string }>(c.req);
    const reason = ["hangup", "cancel", "reject", "timeout", "failed"].includes(String(b.reason)) ? String(b.reason) : "hangup";
    const ended = k.state === "ended" ? k : await finish(c, k, reason, me);
    return json({ call: out(ended) });
  });
}
