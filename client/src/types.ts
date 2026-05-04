// Wire protocol types — mirrors server/src/types.rs

import type { LonLat } from "./geo";

export interface Waypoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  active?: boolean;
}

export interface LocationUpdate {
  lat: number;
  lon: number;
  timestamp_ms: number;
  display_name?: string;
  altitude?: number | null;
  accuracy?: number | null;
  altitude_accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

export interface RouteLeg {
  start_waypoint_id: string;
  end_waypoint_id: string;
  distance_km: number;
  duration_min: number;
  maneuvers: Maneuver[];
}

export interface Maneuver {
  instruction: string;
  distance_km: number;
  duration_min: number;
  /** Valhalla maneuver type (0=None, 1=Start, 9=SlightRight, 10=Right, 15=Left, etc.) */
  maneuver_type: number;
  /** Street names for this segment */
  street_names?: string[];
  /** Index into decoded polyline where this maneuver starts */
  begin_shape_index: number;
  /** Index into decoded polyline where this maneuver ends */
  end_shape_index: number;
}

// Client -> Server
export type ClientMessage =
  | { type: "add_waypoint"; lat: number; lon: number; label: string }
  | { type: "remove_waypoint"; id: string }
  | { type: "move_waypoint"; id: string; lat: number; lon: number }
  | { type: "rename_waypoint"; id: string; label: string }
  | { type: "set_waypoint_active"; id: string; active: boolean }
  | { type: "reorder_waypoints"; ordered_ids: string[] }
  | { type: "request_route" }
  | { type: "request_live_route" }
  | { type: "delete_all" }
  | { type: "undo" };

export type LocationMessage = LocationUpdate & { type: "location" };

// Server -> Client
export type ServerMessage =
  | { type: "waypoint_list"; waypoints: Waypoint[] }
  | { type: "user_count"; count: number }
  | {
      type: "route_result";
      polyline: string;
      distance_km: number;
      duration_min: number;
      legs: RouteLeg[];
    }
  | {
      type: "live_route_result";
      polyline: string;
      distance_km: number;
      duration_min: number;
      legs: RouteLeg[];
      speed_kmh: number;
    }
  | { type: "error"; message: string }
  | LocationMessage
  | { type: "trail"; coords: LonLat[] }
  | { type: "live_status"; live: boolean };

export interface BreadcrumbPoint {
  timestamp_ms: number;
  lon: number;
  lat: number;
  altitude?: number | null;
  accuracy?: number | null;
  altitude_accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

export interface HistoryEntry {
  id: number;
  streamer_id: string;
  platform: string;
  started_at: number;
  ended_at: number;
  stream_title?: string;
  viewer_count?: number;
  breadcrumbs: LonLat[];
  telemetry?: BreadcrumbPoint[];
}
