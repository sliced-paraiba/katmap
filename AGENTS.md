# AI Agent Context

This file provides context for AI coding agents working on KatMap. Read this before making changes.

## Project Summary

KatMap is a real-time collaborative route planner that tracks a streamer's GPS location. Multiple users connect via WebSocket, see the same waypoints, and collaboratively plan pedestrian routes. The server is authoritative over all state. There is no persistence for waypoints — state is in-memory and lost on restart. Stream history (completed breadcrumb trails) is persisted to SQLite.

Live at [katmap.awawawa.mov](https://katmap.awawawa.mov).

## Codebase Orientation

Read `ARCHITECTURE.md` for the full technical walkthrough. Here's the quick version:

- **Server** (`server/src/`): Rust/Axum. `main.rs` (setup), `ws.rs` (WebSocket + AppState), `companion.rs` (location push + ordered trail accumulation), `history.rs` (SQLite persistence + admin editor APIs), `snipe.rs` (private GPS sniping routes), `valhalla.rs` (routing proxy), `resolve.rs` (URL resolver), `admin.rs` (history DB CLI).
- **Client** (`client/src/`): Vanilla TypeScript + Vite. `main.ts` (entry, wiring, theme persistence), `map.ts` (MapLibre map, themes, markers, context menu), `sidebar.ts` (waypoint list, drag-reorder, route display, history browser), `state.ts` (reactive store), `net.ts` (WebSocket client), `types.ts` (wire protocol types).
- **No framework**. Direct DOM manipulation. No React/Vue/Svelte.

## Build and Dev

The project uses Nix for reproducible dev dependencies (gcc, pkg-config, openssl, rustc, cargo, nodejs, just). All dev commands go through `nix-shell`:

```bash
# Dev
docker compose up -d                      # Valhalla routing engine
just dev-server                           # Axum on :3001
just dev-client                           # Vite on :5173 (proxies /ws to :3001)

# Build
just build-client                         # -> client/dist/
just build-server                         # -> server/target/release/katmap-server

# Type-check only
just check-client
```

If `just` is not available in your PATH (common in agent environments), use the equivalent nix-shell commands directly:

```bash
nix-shell shell.nix --command "cd client && npm run build"
nix-shell shell.nix --command "cd server && cargo build --release"
```

## Theme System (Three-File Checklist)

Adding a new map theme requires updating **three files in lockstep**. Missing any one will cause bugs.

### 1. `client/src/map.ts`

Add the theme's short name to the `Theme` type union and map it to its style JSON filename in `THEME_FILE`:

```typescript
// Line ~35
export type Theme = "dark" | "light" | ... | "your-theme" | "raster";

// Line ~37
const THEME_FILE: Record<Exclude<Theme, "raster">, string> = {
  ...
  "your-theme": "your-theme-filename",  // matches style JSON filename
};
```

### 2. `client/src/main.ts`

Add the short name to the `VALID_THEMES` array:

```typescript
// Line ~25
const VALID_THEMES: Theme[] = ["dark", "light", ..., "your-theme", "raster"];
```

### 3. `client/index.html`

Add an `<option>` to the `<select id="theme-select">`:

```html
<option value="your-theme">Your Theme Display Name</option>
```

## Wire Protocol

All WebSocket messages are JSON with a `type` discriminator field. Types are mirrored between `server/src/types.rs` (Rust) and `client/src/types.ts` (TypeScript). Keep them in sync manually when adding new message types.

Client -> Server: `add_waypoint`, `remove_waypoint`, `move_waypoint`, `rename_waypoint`, `reorder_waypoints`, `request_route`, `delete_all`, `undo`

Server -> Client: `waypoint_list`, `location`, `route_result`, `error`, `trail`, `live_status`

See `ARCHITECTURE.md` for full field definitions.

## Companion App (Location Tracking)

Location data comes from a companion app that pushes GPS coordinates to `POST /api/location`:

- The companion sends all `GeolocationCoordinates` properties: `lat`, `lon`, `accuracy`, `altitude`, `altitude_accuracy`, `heading`, `speed`
- Sessions auto-start on first location push and finalize after 15 min of inactivity (stale detection)
- Active trails are saved to SQLite on graceful shutdown
- The `TrailAccumulator` in `companion.rs` stores `BreadcrumbPoint` structs (full telemetry per point)
- Telemetry is persisted to a `telemetry` JSON column in the SQLite `streams` table

## Common Patterns and Gotchas

**Style replacement**: When the map theme changes, `map.setStyle()` removes all custom sources/layers. The code re-adds the route layer and waypoint markers after the `style.load` event. Any new custom layer must follow this pattern.

**Broadcast-only**: The server has no per-client messaging. All `ServerMessage`s go to all clients. This is intentional.

**Polyline precision**: Valhalla uses precision-6 encoded polylines (not Google's precision-5). The server merges multi-leg polylines by decoding, deduplicating junction points, and re-encoding.

**Context menu on mobile**: Desktop uses `contextmenu` event (right-click). Mobile uses a custom long-press handler (500ms touch-hold, cancelled on >10px move). Tap on waypoint markers opens the marker context menu. These are separate code paths in `map.ts`.

**Breadcrumb trail ordering**: `BreadcrumbPoint` includes `timestamp_ms`; `TrailAccumulator::insert_sorted` sorts by timestamp and rebroadcasts the full trail so out-of-order location packets don't kink the displayed trail.

**History edits**: `/admin/history` stores non-destructive GPS edits in the `trail_edits` JSON column. Original `breadcrumbs` remain unchanged; public `/api/history` applies `hidden_indices` and `moved_points` at read time.

**SortableJS handle**: The sidebar drag-reorder is intentionally limited to the `.waypoint-index` handle. Keep labels/buttons clickable and don't make the full waypoint card draggable unless explicitly requested.

**No waypoint persistence**: There is no database for waypoints. All waypoint and undo state is in-memory on the server. This is a deliberate design choice for a stream-session-scoped tool. Stream history (breadcrumbs) IS persisted.
