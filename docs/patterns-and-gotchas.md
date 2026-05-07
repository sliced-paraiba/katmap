# Patterns & Gotchas

Common patterns, pitfalls, and design choices to be aware of when making changes.

## Style Replacement After Theme Change

When the map theme changes, `map.setStyle()` removes **all** custom sources and layers. Theme application is delegated to `themes.ts` — `applyTheme()` accepts an `onLoad` callback that fires after `style.load`. All custom layers (route polyline, trail lines) and markers must be re-added in or after this callback.

**Any new custom layer must follow this pattern.**

## Broadcast-Only Messaging

The server has **no per-client messaging**. All `ServerMessage`s go through a `tokio::sync::broadcast` channel to all connected clients. This means:

- Route results are visible to all clients (not just the requester)
- Error messages are visible to all clients
- There is no concept of a "session" or "user" — everyone sees everything

This is intentional for a collaborative tool. Don't add per-client routing without an explicit design discussion.

## Polyline Precision

Valhalla uses **precision-6** encoded polylines, not Google's precision-5. The server merges multi-leg polylines by:

1. Decoding each leg's precision-6 polyline
2. Concatenating coordinate arrays, skipping duplicate junction points
3. Re-encoding into a single precision-6 polyline
4. Remapping maneuver `begin_shape_index` / `end_shape_index` to account for the merged offset

If you need to decode/encode polylines on the client, make sure to use precision-6.

## No Waypoint Persistence

There is **no database for waypoints**. All waypoint state (`Vec<Waypoint>`) and the undo stack live in-memory on the server (`Arc<RwLock<...>>`). This is a deliberate design choice — the app is ephemeral by nature (route plans for a live stream session).

**Stream history (breadcrumb trails) IS persisted** to SQLite. This is the only persistent data.

## Context Menu: Desktop vs Mobile

Two separate code paths in `map.ts`:

- **Desktop**: Standard `contextmenu` event (right-click) on the map and on markers
- **Mobile**: Custom long-press handler — 500ms touch-hold on the map, cancelled if the touch moves >10px. Tap on waypoint markers opens the marker context menu

Map interaction is disabled while any context menu is open. Right-click drag rotation is permanently disabled (`dragRotate: false`).

## Breadcrumb Trail Ordering

`BreadcrumbPoint` includes `timestamp_ms`. The `TrailAccumulator::insert_sorted` method sorts by timestamp and rebroadcasts the full trail when an out-of-order point arrives. This prevents kinked trails from out-of-order location packets.

## History Edits (Non-Destructive)

`/admin/history` stores GPS edits in the `trail_edits` JSON column:

```typescript
TrailEdits {
  hidden_indices: number[];                 // original breadcrumb indices to omit
  moved_points: Record<number, [lon, lon]>; // original index → replacement coordinate
}
```

The original `breadcrumbs` JSON is **never modified**. The public `/api/history` endpoint applies `hidden_indices` and `moved_points` at read time. This means edits are always reversible — use "Reset per-point" or "Discard all edits" in the admin page.

## SortableJS Handle

The sidebar drag-reorder is intentionally limited to the `.waypoint-index` handle (the numbered circle on each waypoint card). Labels remain clickable for inline editing, and the remove button remains clickable. **Do not make the full waypoint card draggable** unless explicitly requested.

## Undo System

- Before every mutating operation, the current waypoint list is snapshot-cloned and pushed onto a stack
- `undo` pops the stack and replaces the current waypoints
- Stack is capped at 50 entries (oldest dropped when full)
- Undo does **not** push an undo entry (no redo support)
- The undo stack lives on the server, so all clients share the same undo history
- All mutating operations push undo: add, remove, move, rename, `set_waypoint_active`, reorder, delete-all

## Active/Inactive Waypoints

Waypoints have an `active: boolean` field. Only active waypoints are used in route calculations. This lets users plan alternatives without affecting the current route. Toggled via `set_waypoint_active`, which is undo-supported.

Auto-complete (when enabled) automatically sets waypoints `active: false` when the streamer passes through them (within `AUTO_COMPLETE_WAYPOINT_RADIUS_M` meters for `AUTO_COMPLETE_WAYPOINT_DWELL_S` seconds).

## Duplicate Junction Points in Merged Polylines

When merging multi-leg Valhalla polylines, the last coordinate of leg N and first coordinate of leg N+1 are often identical. The merge logic skips these duplicates to avoid visual artifacts on the map (tiny zero-length segments).

## Auto-Route

The client auto-routes when waypoints change: it serializes `[id, lat, lon, active]` for each waypoint, compares with the previous state, clears stale routes, and sends `request_route` if there are ≥2 active waypoints. This is in `main.ts`.

## Live Route (Remaining Waypoints)

Live routes only include waypoints that are ahead of the streamer. The `remaining_waypoints_for_live_route()` function in `ws.rs` projects the streamer's position onto the waypoint path to find the closest segment, then only routes through waypoints from that point forward.

## Toast Notifications

- **Error**: Red, 5 seconds (`setTimeout` clear)
- **Success**: Green, 2 seconds
- **Info**: Themed color, 2 seconds
- Cooldown: repeated identical errors are rate-limited to avoid flooding the UI

## Viewer Counting

WebSocket connections append `?client=overlay` to opt out of viewer counting (used by OBS overlay). Only main app connections increment `connected_count`. The `user_count` message is broadcast to all clients on connect/disconnect.

## Centralized Strings

All user-facing text lives in `client/src/strings.ts`. When adding or changing UI text, update `strings.ts` rather than hardcoding strings. This includes labels, tooltips, format templates, and toast messages.

## Unit System

All measurements support three independent unit toggles (distance, speed, altitude), each switchable between metric and imperial. Use the formatters from `units.ts` rather than hardcoding "km" or "m". The overlay always uses imperial.

## POI Caching

POI lookups via Overpass API are cached server-side for 1 hour (keyed by lat/lon/name). The cache is an in-memory `HashMap` in `AppState.poi_cache`. This avoids rate-limiting from Overpass when multiple users click the same location.
