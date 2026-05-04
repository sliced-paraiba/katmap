import type { LonLat } from "./geo";
import type { BreadcrumbPoint, RouteLeg } from "./types";

export interface TrailEdits {
  hidden_indices: number[];
  moved_points: Record<string, LonLat>;
}

export interface AdminHistoryEntry {
  id: number;
  streamer_id: string;
  platform: string;
  started_at: number;
  ended_at: number;
  session_id?: string | null;
  stream_title?: string | null;
  viewer_count?: number | null;
  hidden: boolean;
  completed: boolean;
  breadcrumbs: LonLat[];
  edited_breadcrumbs: LonLat[];
  edits: TrailEdits;
  telemetry?: BreadcrumbPoint[] | null;
}

export interface AdminUpdateHistoryRequest {
  session_id: string;
  hidden: boolean;
}

export type AdminUpdateHistoryResponse = AdminHistoryEntry;

export type AdminUpdateEditsRequest = TrailEdits;

export interface SnipeLocation {
  lat: number;
  lon: number;
}

export interface UserLocation extends SnipeLocation {
  accuracy?: number;
}

export type TravelMode = "walking" | "cycling" | "car";

export interface SnipeStatus {
  live: boolean;
  streamer: SnipeLocation | null;
  last_location_ts?: number | null;
  age_ms?: number | null;
  last_push_age_ms?: number | null;
}

export interface SnipeRouteRequest extends SnipeLocation {
  mode: TravelMode;
}

export interface SnipeManeuver {
  instruction: string;
  distance_km: number;
  duration_min: number;
  street_names?: string[];
}

export interface SnipeRoute {
  streamer: SnipeLocation;
  polyline: string;
  distance_km: number;
  duration_min: number;
  maneuvers: SnipeManeuver[];
}

export type LocationPayload = {
  type: "location";
  lat: number;
  lon: number;
  timestamp_ms?: number | null;
  altitude?: number | null;
  accuracy?: number | null;
  altitude_accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
};

export type StopPayload = { type: "stop" };
export type DebugPayload = LocationPayload | StopPayload;

export interface DebugPush {
  received_at_ms: number;
  payload: DebugPayload;
}

export interface DebugSnapshot {
  version: { commit: string; build_time: string };
  live: boolean;
  started_at?: number | null;
  breadcrumb_count: number;
  last_location_ts?: number | null;
  age_ms?: number | null;
  last_push_age_ms?: number | null;
  latest_push?: DebugPush | null;
  recent_pushes: DebugPush[];
}

export interface HealthResponse {
  ok: boolean;
  version: { commit: string; build_time: string };
  history: boolean;
  valhalla: boolean;
  live: boolean;
  connected_clients: number;
  last_location_ts?: number | null;
  age_ms?: number | null;
}

export interface RouteResponse {
  polyline: string;
  distance_km: number;
  duration_min: number;
  legs: RouteLeg[];
}
