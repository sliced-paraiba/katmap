# Wire Protocol

All WebSocket messages are JSON objects with a `type` discriminator field, using `snake_case` names.

Types are defined in two places and must be kept in sync manually:

- **Server**: `server/src/types.rs` (Rust, Serde)
- **Client**: `client/src/types.ts` (TypeScript)

## Client → Server (`ClientMessage`)

| Type | Fields | Description |
|---|---|---|
| `add_waypoint` | `lat`, `lon`, `label` | Add a new waypoint. Server assigns a UUID `id`. Waypoint defaults to `active: true` |
| `remove_waypoint` | `id` | Remove a waypoint by ID |
| `move_waypoint` | `id`, `lat`, `lon` | Move a waypoint to new coordinates |
| `rename_waypoint` | `id`, `label` | Change a waypoint's label |
| `set_waypoint_active` | `id`, `active: boolean` | Toggle whether a waypoint is included in route calculations |
| `reorder_waypoints` | `ordered_ids: string[]` | Apply a complete reordering of the waypoint list |
| `request_route` | — | Request route calculation via Valhalla (only active waypoints are included) |
| `request_live_route` | — | Request route from streamer's live location through remaining active waypoints |
| `delete_all` | — | Delete all waypoints (pushes current state to undo stack) |
| `undo` | — | Undo the last mutating operation |

## Server → Client (`ServerMessage`)

| Type | Fields | Description |
|---|---|---|
| `waypoint_list` | `waypoints: Waypoint[]` | Full waypoint state. Sent after every mutation and on initial connect |
| `user_count` | `count: number` | Connected viewer count (excludes `viewer=0` overlay connections) |
| `location` | `lat`, `lon`, `timestamp_ms`, `display_name?`, `altitude?`, `accuracy?`, `altitude_accuracy?`, `heading?`, `speed?` | Streamer's live GPS position with full telemetry |
| `route_result` | `polyline`, `distance_km`, `duration_min`, `legs: RouteLeg[]` | Valhalla route calculation result (active waypoints only) |
| `live_route_result` | `polyline`, `distance_km`, `duration_min`, `legs`, `speed_kmh` | Route from streamer's live position through remaining waypoints ahead of them |
| `error` | `message` | Error message (visible to all clients) |
| `trail` | `coords: [number, number][]` | Accumulated breadcrumb trail coordinates `[lon, lat]` |
| `live_status` | `live: boolean` | Whether the companion location session is active |

The `location` message type is also defined as a standalone `LocationMessage` type in `client/src/types.ts` for reuse:

```typescript
export type LocationMessage = LocationUpdate & { type: "location" };
```

## Data Types

### Waypoint
```typescript
{
  id: string;      // UUID assigned by server
  lat: number;
  lon: number;
  label: string;   // User-visible label (reverse-geocoded or custom)
  active: boolean; // Whether this waypoint is included in routes. Default: true
}
```

### RouteLeg
```typescript
{
  start_waypoint_id: string;
  end_waypoint_id: string;
  distance_km: number;
  duration_min: number;
  maneuvers: Maneuver[];
}
```

### Maneuver
```typescript
{
  instruction: string;
  distance_km: number;
  duration_min: number;
  maneuver_type: number;        // Valhalla maneuver type (0-43)
  street_names?: string[];
  begin_shape_index: number;    // Index into merged polyline
  end_shape_index: number;      // Index into merged polyline
}
```

### BreadcrumbPoint
```typescript
{
  timestamp_ms: number;         // GPS timestamp from companion app
  lon: number;
  lat: number;
  altitude?: number | null;     // meters above sea level
  accuracy?: number | null;     // position accuracy in meters
  altitude_accuracy?: number | null;
  heading?: number | null;      // direction in degrees (0° = north, clockwise)
  speed?: number | null;        // velocity in m/s
}
```

### HistoryEntry
```typescript
{
  id: number;
  streamer_id: string;
  platform: string;             // "companion"
  started_at: number;           // Unix timestamp ms
  ended_at: number;
  stream_title?: string;
  viewer_count?: number;
  breadcrumbs: LonLat[];        // [[lon, lat], ...]
  telemetry?: BreadcrumbPoint[]; // Full telemetry if available
}
```

### TrailEdits
```typescript
{
  hidden_indices: number[];               // Original breadcrumb indices to hide
  moved_points: Record<number, [number, number]>; // index → [lon, lat] replacement
}
```

## Polyline Encoding

Valhalla uses **precision-6** encoded polylines (not Google's precision-5). This matters when decoding/encoding on the client side.

For multi-leg routes, the server:
1. Decodes each leg's precision-6 polyline
2. Merges them into a single array, skipping duplicate junction points
3. Re-encodes into a single precision-6 polyline
4. Remaps `begin_shape_index` / `end_shape_index` on all maneuvers to match the merged polyline

## Sync Model

- **Server-authoritative**: Clients send mutation requests; the server applies them and broadcasts the full updated `waypoint_list`
- **No optimistic updates**: The UI waits for the server echo before reflecting changes
- **Broadcast-only**: All `ServerMessage`s go to all connected clients via `tokio::sync::broadcast`. There is no per-client unicast
- **Reconnect**: On WebSocket reconnect, the server sends the full `waypoint_list`, last known `location`, active `trail`, and `live_status`

## Active/Inactive Waypoints

Waypoints have an `active: boolean` field (default `true`). Only active waypoints are used in route calculations. This lets users plan alternatives without affecting the current route. Toggled via `set_waypoint_active`.
