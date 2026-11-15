// Chính sách kiểm soát dữ liệu. Mọi quyết định "được/không được" đều nằm ở đây và
// chạy trên server: client chỉ ẩn nút cho đỡ khó chịu, không phải là lớp bảo vệ.
import type { Principal } from "./auth";

export interface ConvPolicyRow {
  id: string;
  kind: "dm" | "group";
  managed: number;
  allow_upload: number;
  allow_forward_out: number;
  allow_copy: number;
  allow_save_file: number;
  external: number;
  organization: string;
}

export type FileAccess = "allow" | "view" | "deny";

export interface Decision {
  ok: boolean;
  reason: string;
}

const ALLOW: Decision = { ok: true, reason: "" };
const deny = (reason: string): Decision => ({ ok: false, reason });

/** Gửi tệp/ảnh vào một hội thoại. */
export function canUpload(conv: ConvPolicyRow, settings: Record<string, string>): Decision {
  if (conv.kind === "dm") {
    return settings.dm_upload === "1" ? ALLOW : deny("Không được gửi tệp trong tin nhắn cá nhân");
  }
  if (!conv.managed) return deny("Chỉ được gửi tệp vào nhóm do công ty quản lý");
  if (!conv.allow_upload) return deny("Nhóm này không cho phép gửi tệp");
  return ALLOW;
}

/**
 * Chuyển tiếp một tin nhắn từ `src` sang `dst`.
 * - Nhóm nguồn phải cho phép chuyển tiếp ra ngoài.
 * - Nếu tin có tệp, nơi nhận phải là nơi được phép gửi tệp, nếu không chuyển tiếp sẽ
 *   trở thành đường vòng để vượt lệnh cấm tải tệp lên.
 * - Tin từ nhóm công ty quản lý chỉ được chuyển sang nhóm công ty quản lý khác.
 */
export function canForward(
  src: ConvPolicyRow,
  dst: ConvPolicyRow,
  hasFile: boolean,
  settings: Record<string, string>,
): Decision {
  if (src.id === dst.id) return deny("Không thể chuyển tiếp vào chính hội thoại này");
  // Nhóm có người bên ngoài là điểm dữ liệu rời công ty: chỉ được gửi trực tiếp vào đó
  // (có ghi nhật ký), không bao giờ được chuyển tiếp từ nơi khác vào — kể cả từ nhóm
  // của một đơn vị bên ngoài khác (tránh lộ báo giá NCC này cho NCC kia).
  if (dst.external) return deny("Không được chuyển tiếp vào nhóm có người bên ngoài");
  if (!src.allow_forward_out) return deny("Hội thoại nguồn không cho phép chuyển tiếp tin nhắn");
  if (src.managed && !src.external && !dst.managed) return deny("Tin từ nhóm công ty chỉ được chuyển sang nhóm công ty");
  if (src.external && !dst.managed) return deny("Tin từ nhóm có người bên ngoài chỉ được chuyển sang nhóm công ty");
  if (hasFile) {
    const up = canUpload(dst, settings);
    if (!up.ok) return deny(`Không thể chuyển tiếp tệp: ${up.reason.toLowerCase()}`);
  }
  return ALLOW;
}

/** Mức truy cập tệp theo thiết bị. */
export function fileAccess(conv: ConvPolicyRow, who: Principal, settings: Record<string, string>): FileAccess {
  // Nhóm có người bên ngoài: tệp gửi vào đó vốn để đưa cho đối tác, áp dụng đúng cờ của nhóm.
  if (conv.external) return conv.allow_save_file ? "allow" : "view";
  const mobile = who.platform === "android" || who.platform === "ios";
  if (mobile && !who.trusted) {
    const m = settings.mobile_untrusted_files;
    if (m === "deny") return "deny";
    if (m === "view") return "view";
  }
  return conv.allow_save_file ? "allow" : "view";
}

/** Cờ gửi xuống client để ẩn/hiện chức năng tương ứng. */
export function clientFlags(conv: ConvPolicyRow, who: Principal, settings: Record<string, string>) {
  return {
    can_upload: canUpload(conv, settings).ok,
    can_forward_out: !!conv.allow_forward_out && who.kind === "internal",
    can_copy: !!conv.allow_copy,
    file_access: fileAccess(conv, who, settings),
  };
}

/** Mặc định chính sách cho hội thoại mới. */
export function defaultsFor(kind: "dm" | "group", managed: boolean, external = false) {
  if (external) return { allow_upload: 1, allow_forward_out: 1, allow_copy: 1, allow_save_file: 1 };
  if (managed) return { allow_upload: 1, allow_forward_out: 0, allow_copy: 0, allow_save_file: 0 };
  if (kind === "dm") return { allow_upload: 0, allow_forward_out: 1, allow_copy: 1, allow_save_file: 0 };
  return { allow_upload: 0, allow_forward_out: 1, allow_copy: 1, allow_save_file: 0 };
}

/** Người bên ngoài chỉ hoạt động trong nhóm được công ty mở cho họ. */
export function requireInternal(who: Principal, what: string) {
  if (who.kind !== "internal") return deny(`Tài khoản bên ngoài không được ${what}`);
  return ALLOW;
}

/** Ai được đưa vào một nhóm. */
export function canJoin(
  conv: { external: number; organization: string },
  user: { kind: string; organization: string },
): Decision {
  if (user.kind === "external") {
    if (!conv.external) return deny("Không được thêm người bên ngoài vào nhóm nội bộ");
    if (user.organization !== conv.organization)
      return deny(`Nhóm này chỉ dành cho đơn vị "${conv.organization}"`);
  }
  return ALLOW;
}
