import { ClientMessage, ServerMessage } from "./types";

export type OnMessageCallback = (msg: ServerMessage) => void;
export type OnStatusChange = (connected: boolean) => void;

export interface ConnectionOptions {
  client?: string;
  countAsViewer?: boolean;
  autoConnect?: boolean;
  logPrefix?: string;
}

export class Connection {
  private ws: WebSocket | null = null;
  private onMessage: OnMessageCallback;
  private onStatus: OnStatusChange;
  private options: ConnectionOptions;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    onMessage: OnMessageCallback,
    onStatus: OnStatusChange,
    options: ConnectionOptions = {},
  ) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.options = options;
    if (options.autoConnect !== false) {
      this.connect();
    }
  }

  private connect() {
    if (!this.shouldReconnect) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    if (this.options.client) params.set("client", this.options.client);
    if (this.options.countAsViewer === false) params.set("viewer", "0");
    if (this.options.countAsViewer === true) params.set("viewer", "1");
    const query = params.toString();
    const url = `${protocol}//${location.host}/ws${query ? `?${query}` : ""}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log(`${this.logPrefix()} connected`);
      this.reconnectDelay = 1000;
      this.onStatus(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.onMessage(msg);
      } catch (e) {
        console.error(`${this.logPrefix()} failed to parse message:`, e);
      }
    };

    this.ws.onclose = () => {
      console.log(`${this.logPrefix()} disconnected`);
      this.onStatus(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (e) => {
      console.error(`${this.logPrefix()} error:`, e);
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
    console.log(`${this.logPrefix()} reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  destroy() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
  }

  private logPrefix() {
    return this.options.logPrefix ?? "[ws]";
  }
}
