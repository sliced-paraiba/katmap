import { ClientMessage, ServerMessage } from "./types";

export type OnMessageCallback = (msg: ServerMessage) => void;
export type OnStatusChange = (connected: boolean) => void;

export class Connection {
  private ws: WebSocket | null = null;
  private onMessage: OnMessageCallback;
  private onStatus: OnStatusChange;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;

  constructor(onMessage: OnMessageCallback, onStatus: OnStatusChange) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.connect();
  }

  private connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[ws] connected");
      this.reconnectDelay = 1000;
      this.onStatus(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.onMessage(msg);
      } catch (e) {
        console.error("[ws] failed to parse message:", e);
      }
    };

    this.ws.onclose = () => {
      console.log("[ws] disconnected");
      this.onStatus(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (e) => {
      console.error("[ws] error:", e);
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );
    console.log(`[ws] reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  destroy() {
    this.shouldReconnect = false;
    this.ws?.close();
  }
}
