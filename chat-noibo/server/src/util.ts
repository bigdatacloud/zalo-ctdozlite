import type { UserHub } from "./hub";
import type { PushJob } from "./push";

export interface Env {
  DB: D1Database;
  /** Nhật ký kiểm soát (DB riêng). Không cấu hình thì dùng chung DB. */
  AUDIT?: D1Database;
  FILES: R2Bucket;
  HUB: DurableObjectNamespace<UserHub>;
  CORS_ORIGIN: string;
  MAX_UPLOAD_BYTES: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  /** Tệp JSON khóa tài khoản dịch vụ Firebase (secret). Không đặt = tắt thông báo đẩy. */
  FCM_SERVICE_ACCOUNT?: string;
  /** Chỉ dùng khi kiểm thử. */
  FCM_API_BASE?: string;
  /** Khóa TURN của Cloudflare (Realtime) cho gọi thoại qua mạng 4G/NAT. Không có thì chỉ dùng STUN. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Chỉ dùng khi kiểm thử: thời gian coi một đầu cuộc gọi là đã rớt. */
  CALL_STALE_MS?: string;
  /** Hàng đợi gửi thông báo đẩy (nhóm lớn). Không cấu hình thì gửi trực tiếp. */
  PUSH_QUEUE?: Queue<PushJob>;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export const now = () => Date.now();

export function newId(prefix: string): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `${prefix}_${b64url(b)}`;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "bad_json", "Nội dung yêu cầu không phải JSON hợp lệ");
  }
}

export function str(v: unknown, field: string, max = 4000, min = 1): string {
  if (typeof v !== "string") throw new HttpError(400, "bad_field", `Thiếu trường ${field}`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, "bad_field", `Trường ${field} không hợp lệ`);
  return t;
}

export function bool01(v: unknown): 0 | 1 | undefined {
  if (v === undefined) return undefined;
  return v ? 1 : 0;
}

export const auditDb = (env: Env) => env.AUDIT ?? env.DB;

/** Hành động chỉ ghi một lần cho cùng người + cùng đối tượng trong 12 giờ (xem ảnh/tệp lặp lại). */
const DEDUPE_ACTIONS = new Set(["file_view", "approval_preview"]);

export async function audit(
  env: Env,
  e: {
    user_id?: string | null;
    device_id?: string | null;
    action: string;
    conversation_id?: string | null;
    target?: string | null;
    allowed: boolean;
    detail?: string;
  },
) {
  const t = now();
  const vals = [t, e.user_id ?? null, e.device_id ?? null, e.action, e.conversation_id ?? null, e.target ?? null, e.allowed ? 1 : 0, e.detail ?? ""];
  if (DEDUPE_ACTIONS.has(e.action) && e.allowed && e.user_id) {
    await auditDb(env)
      .prepare(
        `INSERT INTO audit(at,user_id,device_id,action,conversation_id,target,allowed,detail)
         SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (
           SELECT 1 FROM audit WHERE user_id = ? AND at > ? AND action = ? AND target IS ? AND allowed = 1)`,
      )
      .bind(...vals, e.user_id, t - 12 * 3600 * 1000, e.action, e.target ?? null)
      .run();
    return;
  }
  await auditDb(env)
    .prepare("INSERT INTO audit(at,user_id,device_id,action,conversation_id,target,allowed,detail) VALUES (?,?,?,?,?,?,?,?)")
    .bind(...vals)
    .run();
}

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const r = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}
