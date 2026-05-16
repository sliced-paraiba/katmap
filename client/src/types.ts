// Wire protocol types are generated from server/src/types.rs.
import type {
  BreadcrumbPoint as WireBreadcrumbPoint,
  ServerMessage as WireServerMessage,
} from "./generated/types";
import type { LonLat } from "./geo";

export type {
  BreadcrumbPoint,
  ClientMessage,
  Maneuver,
  RouteLeg,
  ServerMessage,
  Waypoint,
} from "./generated/types";

export type LocationMessage = Extract<WireServerMessage, { type: "location" }>;
export type LocationUpdate = Omit<LocationMessage, "type">;

export interface HistoryEntry {
  id: number;
  streamer_id: string;
  platform: string;
  started_at: number;
  ended_at: number;
  stream_title?: string;
  viewer_count?: number;
  breadcrumbs: LonLat[];
  telemetry?: WireBreadcrumbPoint[];
}
