import { Env, HttpError, b64url, fromB64url, now, sha256Hex } from "./util";

// Workers giới hạn PBKDF2 ở 100 000 vòng.
const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export interface Principal {
  user_id: string;
  username: string;
  display_name: string;
  role: "admin" | "member";
  device_id: string;
  platform: string;
  trusted: boolean;
  must_change_password: boolean;
}

export async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: b64url(bits), salt: b64url(salt) };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  const h = await hashPassword(password, salt);
  return timingSafeEqual(h.hash, hash);
}

export function validatePassword(p: string) {
  if (p.length < 8) throw new HttpError(400, "weak_password", "Mật khẩu phải có ít nhất 8 ký tự");
}

export async function createSession(env: Env, user_id: string, device_id: string) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = b64url(raw);
  const t = now();
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,device_id,created_at,expires_at) VALUES (?,?,?,?,?)")
    .bind(await sha256Hex(token), user_id, device_id, t, t + SESSION_TTL_MS)
    .run();
  return token;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  // WebSocket từ trình duyệt không đặt được header -> cho phép truyền qua query.
  const q = new URL(req.url).searchParams.get("token");
  return q;
}

export async function authenticate(env: Env, req: Request): Promise<Principal> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "unauthenticated", "Chưa đăng nhập");
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.device_id, s.expires_at, u.username, u.display_name, u.role, u.status,
            u.must_change_password, d.platform, d.trusted, d.revoked_at
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id
      WHERE s.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<{
      user_id: string;
      device_id: string;
      expires_at: number;
      username: string;
      display_name: string;
      role: "admin" | "member";
      status: string;
      must_change_password: number;
      platform: string;
      trusted: number;
      revoked_at: number | null;
    }>();
  if (!row || row.expires_at < now()) throw new HttpError(401, "session_expired", "Phiên đăng nhập đã hết hạn");
  if (row.status !== "active") throw new HttpError(401, "account_disabled", "Tài khoản đã bị khóa");
  if (row.revoked_at) throw new HttpError(401, "device_revoked", "Thiết bị đã bị thu hồi quyền truy cập");
  return {
    user_id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    device_id: row.device_id,
    platform: row.platform,
    trusted: row.trusted === 1,
    must_change_password: row.must_change_password === 1,
  };
}
