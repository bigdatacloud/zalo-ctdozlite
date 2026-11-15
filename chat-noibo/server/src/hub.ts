// Durable Object: mỗi người dùng một hub giữ WebSocket của mọi thiết bị đang mở.
// Dùng WebSocket Hibernation để không tốn tiền khi không có tin nhắn.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./util";

export class UserHub extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const deviceId = req.headers.get("x-device-id") ?? "unknown";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.send(JSON.stringify({ type: "hello", at: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Đẩy một sự kiện tới mọi thiết bị của người dùng. */
  async push(event: unknown): Promise<number> {
    const data = JSON.stringify(event);
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
        n++;
      } catch {
        /* socket đã đóng */
      }
    }
    return n;
  }

  /** Thu hồi một thiết bị (hoặc tất cả khi deviceId = null): yêu cầu client xóa dữ liệu rồi ngắt kết nối. */
  async revoke(deviceId: string | null, reason: string): Promise<void> {
    const sockets = deviceId ? this.ctx.getWebSockets(deviceId) : this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify({ type: "revoked", wipe: true, reason }));
        ws.close(4001, "revoked");
      } catch {
        /* bỏ qua */
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Client chỉ gửi ping để giữ kết nối; mọi thao tác ghi đi qua HTTP để có kiểm soát chính sách.
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {
      /* đã đóng */
    }
  }
}
