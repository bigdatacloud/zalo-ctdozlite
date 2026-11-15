// Lưu trữ dữ liệu cũ ra R2 để cơ sở dữ liệu D1 (tối đa 10 GB) không đầy.
//
// - Tin chữ cũ hơn `archive_after_days` (mặc định 180 ngày): gom theo hội thoại + tháng, nén
//   gzip, ghi vào R2 rồi xóa khỏi D1. Người dùng cuộn lên vẫn xem được: API tin nhắn tự ghép
//   dữ liệu từ D1 và R2 theo đúng thứ tự.
// - Tin có tệp KHÔNG lưu trữ (nhỏ, và quyền mở tệp dựa vào chúng).
// - Nhật ký cũ hơn `audit_keep_days`: ghi ra R2 theo lô, quản trị viên tải về khi cần điều tra.
import { auditDb, Env, getSettings, newId, now } from "./util";

/** Phải trùng với lịch trong wrangler.toml: 02:17 sáng giờ Việt Nam. */
export const ARCHIVE_CRON = "17 19 * * *";

const BATCH_ROWS = 20_000;
const VN_OFFSET_S = 7 * 3600;

export interface ArchivedMsg {
  id: string;
  conversation_id: string;
  seq: number;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  sender_org: string;
  kind: string;
  text: string;
  file_id: null;
  file_name: null;
  file_mime: null;
  file_size: null;
  reply_to: string | null;
  forwarded_from: string | null;
  client_id: string | null;
  created_at: number;
  recalled_at: number | null;
}

async function gzipJsonl(rows: unknown[]): Promise<ArrayBuffer> {
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

async function gunzipJsonl<T>(body: ReadableStream): Promise<T[]> {
  const text = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
  return text ? text.split("\n").map((l) => JSON.parse(l) as T) : [];
}

/** Bộ nhớ đệm trong isolate cho các tệp lưu trữ vừa đọc (người dùng hay cuộn qua lại). */
const cache = new Map<string, ArchivedMsg[]>();

export async function loadArchive(env: Env, key: string): Promise<ArchivedMsg[]> {
  const hit = cache.get(key);
  if (hit) return hit;
  const obj = await env.FILES.get(key);
  if (!obj) return [];
  const rows = await gunzipJsonl<ArchivedMsg>(obj.body);
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  cache.set(key, rows);
  return rows;
}

/**
 * Ghép một trang tin cũ (seq < before) từ D1 và các tệp lưu trữ, giảm dần theo seq.
 * `d1Desc` là kết quả D1 đã sắp giảm dần, tối đa `limit` dòng.
 */
export async function mergeArchived<T extends { seq: number }>(
  env: Env,
  convId: string,
  before: number,
  limit: number,
  d1Desc: T[],
): Promise<(T | ArchivedMsg)[]> {
  const arcs = await env.DB.prepare(
    "SELECT r2_key, max_seq FROM archives WHERE conversation_id = ? AND min_seq < ? ORDER BY max_seq DESC",
  )
    .bind(convId, before)
    .all<{ r2_key: string; max_seq: number }>();
  let rows: (T | ArchivedMsg)[] = d1Desc;
  for (const a of arcs.results) {
    // Đã đủ trang và tệp lưu trữ này toàn tin cũ hơn tin cuối trang: dừng.
    if (rows.length >= limit && a.max_seq < rows[limit - 1].seq) break;
    const more = (await loadArchive(env, a.r2_key)).filter((m) => m.seq < before);
    rows = [...rows, ...more].sort((x, y) => y.seq - x.seq).slice(0, limit);
  }
  return rows;
}

/** Lưu trữ tin chữ cũ. Trả về số tin đã chuyển. Có giới hạn thời gian để vừa một lần chạy định kỳ. */
export async function archiveMessages(env: Env, olderThanDays?: number, budgetMs = 20_000): Promise<number> {
  const settings = await getSettings(env);
  const days = olderThanDays ?? Number(settings.archive_after_days || 180);
  const cutoff = now() - days * 86_400_000;
  const started = Date.now();
  let moved = 0;
  while (Date.now() - started < budgetMs) {
    const g = await env.DB.prepare(
      `SELECT conversation_id, strftime('%Y-%m', created_at / 1000 + ${VN_OFFSET_S}, 'unixepoch') AS month
         FROM messages WHERE created_at < ? AND file_id IS NULL
        GROUP BY conversation_id, month ORDER BY MIN(created_at) LIMIT 1`,
    )
      .bind(cutoff)
      .first<{ conversation_id: string; month: string }>();
    if (!g) break;
    const rows = (
      await env.DB.prepare(
        `SELECT m.id, m.conversation_id, m.seq, m.sender_id, u.display_name AS sender_name, u.kind AS sender_kind,
                u.organization AS sender_org, m.kind, m.text, NULL AS file_id, NULL AS file_name, NULL AS file_mime,
                NULL AS file_size, m.reply_to, m.forwarded_from, m.client_id, m.created_at, m.recalled_at
           FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? AND m.created_at < ? AND m.file_id IS NULL
            AND strftime('%Y-%m', m.created_at / 1000 + ${VN_OFFSET_S}, 'unixepoch') = ?
          ORDER BY m.seq LIMIT ${BATCH_ROWS}`,
      )
        .bind(g.conversation_id, cutoff, g.month)
        .all<ArchivedMsg>()
    ).results;
    if (!rows.length) break;
    const min = rows[0].seq;
    const max = rows[rows.length - 1].seq;
    // Khóa xác định: chạy lại sau sự cố sẽ ghi đè đúng tệp, không sinh bản trùng.
    const key = `archive/messages/${g.conversation_id}/${g.month}-${min}-${max}.jsonl.gz`;
    await env.FILES.put(key, await gzipJsonl(rows), {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { conversation_id: g.conversation_id, count: String(rows.length) },
    });
    // seq và created_at cùng tăng trong một hội thoại, nên khoảng [min, max] chỉ chứa đúng các tin này
    // (cộng các tin có tệp, vốn được giữ lại).
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO archives(id,conversation_id,min_seq,max_seq,count,r2_key,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO NOTHING",
      ).bind(newId("ar"), g.conversation_id, min, max, rows.length, key, now()),
      env.DB.prepare("DELETE FROM messages WHERE conversation_id = ? AND seq BETWEEN ? AND ? AND file_id IS NULL AND created_at < ?").bind(
        g.conversation_id,
        min,
        max,
        cutoff,
      ),
    ]);
    moved += rows.length;
  }
  return moved;
}

/** Lưu trữ nhật ký cũ ra R2 theo lô. */
export async function archiveAudit(env: Env, olderThanDays?: number, budgetMs = 20_000): Promise<number> {
  const settings = await getSettings(env);
  const days = olderThanDays ?? Number(settings.audit_keep_days || 730);
  const cutoff = now() - days * 86_400_000;
  const db = auditDb(env);
  const started = Date.now();
  let moved = 0;
  while (Date.now() - started < budgetMs) {
    const rows = (await db.prepare(`SELECT * FROM audit WHERE at < ? ORDER BY id LIMIT ${BATCH_ROWS}`).bind(cutoff).all<{ id: number; at: number }>())
      .results;
    if (!rows.length) break;
    const min = rows[0].id;
    const max = rows[rows.length - 1].id;
    const month = new Date(rows[0].at + VN_OFFSET_S * 1000).toISOString().slice(0, 7);
    const key = `archive/audit/${month}-${min}-${max}.jsonl.gz`;
    await env.FILES.put(key, await gzipJsonl(rows), {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { count: String(rows.length) },
    });
    await db.prepare("DELETE FROM audit WHERE id BETWEEN ? AND ? AND at < ?").bind(min, max, cutoff).run();
    moved += rows.length;
  }
  return moved;
}
