import {
  Waypoint,
  LocationUpdate,
  RouteLeg,
  ServerMessage,
  HistoryEntry,
} from "./types";

export type StateListener = () => void;

export interface SocialLinks {
  discord: string | null;
  kick: string | null;
  twitch: string | null;
}

export class AppState {
  waypoints: Waypoint[] = [];
  location: LocationUpdate | null = null;
  /** Breadcrumb track for the current session: [lon, lat][] for MapLibre */
  breadcrumbCoords: [number, number][] = [];
  route: {
    polyline: string;
    distance_km: number;
    duration_min: number;
    legs: RouteLeg[];
  } | null = null;
  /** Live route from the streamer's current position through all waypoints. */
  liveRoute: {
    polyline: string;
    distance_km: number;
    duration_min: number;
    legs: RouteLeg[];
    speed_kmh: number;
  } | null = null;
  connected = false;
  connectedCount = 0;
  /** Whether the companion app session is active */
  live = false;
  lastError: string | null = null;
  errorTimestamp = 0;
  socialLinks: SocialLinks = { discord: null, kick: null, twitch: null };

  /** Breadcrumb trail of the currently selected historical stream */
  historyTrail: [number, number][] = [];
  historyStreams: HistoryEntry[] = [];
  selectedHistoryId: number | null = null;

  private listeners: StateListener[] = [];

  subscribe(listener: StateListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Subscribe for a single notification, then auto-unsubscribe. Returns the unsubscribe fn. */
  subscribeOnce(listener: StateListener): () => void {
    const unsub = this.subscribe(() => {
      listener();
      unsub();
    });
    return unsub;
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setConnected(connected: boolean) {
    this.connected = connected;
    this.notify();
  }

  setError(message: string) {
    this.lastError = message;
    this.errorTimestamp = Date.now();
    this.notify();
  }

  clearError() {
    this.lastError = null;
    this.notify();
  }

  clearRoute() {
    this.route = null;
    this.liveRoute = null;
    this.notify();
  }

  /** Called via WebSocket server message. */
  setLocation(loc: LocationUpdate) {
    this.location = loc;
    this.notify();
  }

  /** Replace the full breadcrumb track (called on session start and full data put). */
  setBreadcrumbs(coords: [number, number][]) {
    this.breadcrumbCoords = coords;
    this.notify();
  }

  /** Set the currently selected historical stream to view its trail. */
  selectHistoryStream(id: number | null) {
    this.selectedHistoryId = id;
    if (id === null) {
      this.historyTrail = [];
    } else {
      const entry = this.historyStreams.find((e) => e.id === id);
      this.historyTrail = entry?.breadcrumbs ?? [];
    }
    this.notify();
  }

  /** Fetch past streams from the server. */
  async fetchHistory(): Promise<void> {
    try {
      const resp = await fetch("/api/history");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.historyStreams = await resp.json() as HistoryEntry[];
      if (this.selectedHistoryId !== null) {
        const entry = this.historyStreams.find((e) => e.id === this.selectedHistoryId);
        this.historyTrail = entry?.breadcrumbs ?? [];
      }
      this.notify();
    } catch (e) {
      console.error("[state] failed to fetch history:", e);
    }
  }

  applyServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "waypoint_list":
        this.waypoints = msg.waypoints;
        break;
      case "user_count":
        this.connectedCount = msg.count;
        break;
      case "route_result":
        this.route = {
          polyline: msg.polyline,
          distance_km: msg.distance_km,
          duration_min: msg.duration_min,
          legs: msg.legs,
        };
        break;
      case "live_route_result":
        this.liveRoute = {
          polyline: msg.polyline,
          distance_km: msg.distance_km,
          duration_min: msg.duration_min,
          legs: msg.legs,
          speed_kmh: msg.speed_kmh,
        };
        break;
      case "error":
        this.lastError = msg.message;
        this.errorTimestamp = Date.now();
        console.error("[server error]", msg.message);
        break;
      case "location":
        this.location = {
          lat: msg.lat,
          lon: msg.lon,
          timestamp_ms: msg.timestamp_ms,
          display_name: msg.display_name,
          altitude: msg.altitude,
          accuracy: msg.accuracy,
          altitude_accuracy: msg.altitude_accuracy,
          heading: msg.heading,
          speed: msg.speed,
        };
        break;
      case "trail":
        this.breadcrumbCoords = msg.coords;
        break;
      case "live_status":
        this.live = msg.live;
        break;
    }
    this.notify();
  }
}
