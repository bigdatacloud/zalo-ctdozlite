// Thông báo đẩy qua Firebase Cloud Messaging (FCM HTTP v1).
//
// FCM chỉ là "người đưa thư": Android nhận qua dịch vụ Google, iPhone qua APNs của Apple
// (Firebase chuyển tiếp). Vì thông báo đi qua máy chủ Google/Apple nên KHÔNG BAO GIỜ gửi
// nội dung tin nhắn — chỉ gửi tên người gửi/nhóm (hoặc không gì cả, tùy chính sách
// `push_content`). Ứng dụng mở ra sẽ tự tải nội dung từ máy chủ công ty.
//
// Cấu hình: npx wrangler secret put FCM_SERVICE_ACCOUNT  (dán nguyên tệp JSON khóa tài khoản dịch vụ)
import type { Env } from "./util";
import { b64url, getSettings } from "./util";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PushNote {
  title: string;
  body: string;
  data: Record<string, string>;
  /** Thông báo cùng nhóm thay thế nhau trên màn hình khóa, không xếp chồng. */
  collapse: string;
}

let cached: { token: string; exp: number; email: string } | null = null;

function serviceAccount(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    return JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    console.error("FCM_SERVICE_ACCOUNT không phải JSON hợp lệ");
    return null;
  }
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  if (cached && cached.email === sa.client_email && cached.exp - 60 > nowS) return cached.token;
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: tokenUri,
    iat: nowS,
    exp: nowS + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${b64url(sig)}`,
  });
  if (!res.ok) throw new Error(`FCM token ${res.status}: ${await res.text()}`);
  const d = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: d.access_token, exp: nowS + (d.expires_in || 3600), email: sa.client_email };
  return d.access_token;
}

/** Gửi một thông báo tới mọi thiết bị (chưa thu hồi, có push token) của các người dùng. */
export async function pushToUsers(env: Env, userIds: string[], note: PushNote): Promise<number> {
  const sa = serviceAccount(env);
  if (!sa || !userIds.length) return 0;
  const rows: { id: string; push_token: string }[] = [];
  // D1 giới hạn số tham số mỗi câu lệnh: chia lô.
  for (let i = 0; i < userIds.length; i += 90) {
    const part = userIds.slice(i, i + 90);
    const r = await env.DB.prepare(
      `SELECT d.id, d.push_token FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.user_id IN (${part.map(() => "?").join(",")}) AND d.push_token IS NOT NULL
          AND d.revoked_at IS NULL AND u.status = 'active'`,
    )
      .bind(...part)
      .all<{ id: string; push_token: string }>();
    rows.push(...r.results);
  }
  if (!rows.length) return 0;
  const token = await accessToken(sa);
  const base = env.FCM_API_BASE || "https://fcm.googleapis.com";
  const url = `${base}/v1/projects/${sa.project_id}/messages:send`;
  let sent = 0;
  // FCM v1 không còn API gửi lô: gửi song song từng nhóm 50 để không vượt giới hạn kết nối của Worker.
  for (let i = 0; i < rows.length; i += 50) {
    await Promise.all(
      rows.slice(i, i + 50).map(async (d) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: d.push_token,
              notification: { title: note.title, body: note.body },
              data: note.data,
              android: { priority: "high", collapse_key: note.collapse, notification: { tag: note.collapse } },
              apns: {
                headers: { "apns-collapse-id": note.collapse.slice(0, 64) },
                payload: { aps: { sound: "default", "thread-id": note.collapse } },
              },
            },
          }),
        }).catch(() => null);
        if (!res) return;
        if (res.ok) {
          sent++;
          return;
        }
        const body = await res.text();
        // Token không còn hiệu lực (gỡ app, cài lại...): bỏ đi để lần sau không gửi nữa.
        if (res.status === 404 || body.includes("UNREGISTERED") || body.includes("registration-token-not-registered")) {
          await env.DB.prepare("UPDATE devices SET push_token = NULL WHERE id = ?").bind(d.id).run();
        } else {
          console.error(`FCM ${res.status}: ${body.slice(0, 300)}`);
        }
      }),
    );
  }
  return sent;
}

/** Thông báo tin nhắn mới: không bao giờ kèm nội dung tin. */
export async function pushNewMessage(
  env: Env,
  m: { conversation_id: string; sender_id: string; sender_name: string; kind: string },
  conv: { kind: string; name: string },
  recipients: string[],
) {
  if (m.kind === "system") return;
  const settings = await getSettings(env);
  const showNames = settings.push_content !== "none";
  const what = m.kind === "image" ? "đã gửi một ảnh" : m.kind === "file" ? "đã gửi một tệp" : "đã gửi tin nhắn";
  const note: PushNote = showNames
    ? {
        title: conv.kind === "group" ? conv.name : m.sender_name,
        body: conv.kind === "group" ? `${m.sender_name} ${what}` : what.charAt(0).toUpperCase() + what.slice(1),
        data: { type: "message", conversation_id: m.conversation_id },
        collapse: m.conversation_id,
      }
    : {
        title: "Chat Nội Bộ",
        body: "Bạn có tin nhắn mới",
        data: { type: "message", conversation_id: m.conversation_id },
        collapse: "new-messages",
      };
  await pushToUsers(env, recipients.filter((u) => u !== m.sender_id), note);
}
