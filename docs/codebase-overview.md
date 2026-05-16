# Codebase Overview

KatMap is a client-server application communicating over a single WebSocket connection. The server is the source of truth for all waypoint state. Every connected client sees the same waypoints in real time. A companion app pushes GPS coordinates to the server via a REST endpoint.

Live at [katmap.awawawa.mov](https://katmap.awawawa.mov).

## Stack

- **Server**: Rust / Axum, WebSocket-based, authoritative over waypoint state
- **Client**: Vanilla TypeScript + Vite + MapLibre GL JS (**no framework** — direct DOM manipulation)
- **Routing**: Valhalla (Docker), pedestrian route planning + car/cycling/walking sniping routes
- **Tiles**: Self-hosted PMTiles vector tiles served by Caddy, 8 map themes + raster fallback
- **Location**: Companion app pushes GPS via REST API (full telemetry)
- **History**: Stream breadcrumbs persisted to SQLite, browsable in the UI, editable via authenticated admin page

## Project Structure

```
katmap/
├── server/src/
│   ├── main.rs          # Axum setup, env vars, route registration, static file serving
│   ├── types.rs         # Serde message types (ClientMessage/ServerMessage)
│   ├── ws.rs            # WebSocket handler, AppState, undo stack, live route logic
│   ├── companion.rs     # Companion app location push, ordered trail accumulation
│   ├── history.rs       # SQLite history persistence + authenticated web editor APIs
│   ├── snipe.rs         # Authenticated stream-sniping GPS route API/page
│   ├── valhalla.rs      # Valhalla route calculation proxy
│   ├── resolve.rs       # Google Maps short link resolution
│   ├── poi.rs           # POI lookup via Overpass API (cached)
│   ├── debug.rs         # Debug endpoints (/api/version, /api/health, location push snapshot)
│   ├── auth.rs          # Authentication helpers
│   └── admin.rs         # CLI tool for history DB maintenance
├── client/src/
│   ├── main.ts          # Entry point — wires state, net, map, sidebar, theme persistence
│   ├── overlay.ts       # OBS overlay entry point (browser source)
│   ├── admin-history.ts # Authenticated history editor entry point
│   ├── snipe.ts         # Authenticated stream-sniping GPS page entry point
│   ├── debug-location-pushes.ts  # Debug page showing recent companion pushes
│   ├── weather-overlay.ts        # Weather overlay entry point
│   ├── types.ts         # TypeScript message types (mirrors server/types.rs)
│   ├── net.ts           # WebSocket client with exponential backoff reconnect
│   ├── state.ts         # Reactive app state (pub/sub)
│   ├── map.ts           # MapLibre GL JS — markers, route layer, context menu, POI
│   ├── sidebar.ts       # Waypoint list, drag-reorder, route maneuvers, history browser
│   ├── themes.ts        # Theme definitions, fetch, apply, PMTiles registration (shared)
│   ├── settings.ts      # Settings popup — theme select + per-measurement unit toggles
│   ├── strings.ts       # Centralized UI strings (all user-facing text)
│   ├── units.ts         # Unit system — metric/imperial conversion + formatting
│   ├── geo.ts           # Coordinate types (LonLat, LatLon), haversine distance
│   └── style.css        # Main app styles
```

## Server Files

| File | Purpose |
|---|---|
| `main.rs` | Axum server setup, environment variable parsing, `AppState` construction, route registration, graceful shutdown with trail save |
| `types.rs` | Serde-annotated enums for `ClientMessage`, `ServerMessage`, and supporting structs (`Waypoint`, `RouteLeg`, `Maneuver`, `BreadcrumbPoint`) |
| `ws.rs` | WebSocket upgrade handler, `AppState` definition (all shared mutable state), message dispatch, undo system, route/broadcast logic, live route remaining-waypoint projection |
| `companion.rs` | `POST /api/location` handler, `TrailAccumulator` for ordered breadcrumb accumulation, stale session detection (15 min timeout), graceful shutdown save, incomplete trail recovery on restart |
| `history.rs` | SQLite schema + queries for stream history, `GET /api/history` public endpoint (with non-destructive edit application), authenticated admin CRUD APIs (list, update, delete, edits) |
| `snipe.rs` | `GET /snipe` page redirect, `/api/snipe/status` and `/api/snipe/route` endpoints for authenticated GPS sniping. Rate-limited via `SnipeRouteLimiter` |
| `valhalla.rs` | Route calculation proxy — takes waypoint list, POSTs to Valhalla, merges multi-leg precision-6 polylines, remaps maneuver shape indices |
| `resolve.rs` | `GET /resolve-url` — follows Google Maps short link redirects to extract full URLs (whitelisted to Google Maps hosts only) |
| `poi.rs` | `GET /api/poi` — Overpass API proxy for point-of-interest lookup near a coordinate. Results cached for 1 hour |
| `debug.rs` | Debug/ops endpoints: `/api/version` (compile-time metadata), `/api/health` (server status), `/api/debug/location-pushes` (recent companion push snapshot). Tracks last 200 location pushes |
| `auth.rs` | Authentication helpers for bearer token extraction |
| `admin.rs` | Standalone CLI binary (`katmap-admin`) for SQLite maintenance — list, hide, delete stream history entries |

## Client Files

| File | Purpose |
|---|---|
| `main.ts` | App bootstrap — creates state, connection, map, sidebar, settings instances, wires them together. Handles theme persistence, mobile sidebar toggle, `Ctrl+Z` undo, auto-route on waypoint changes, dynamic favicon, update polling, toast notifications |
| `overlay.ts` | OBS browser source — shows streamer location, speed, altitude, GPS status. Self-contained with its own MapLibre instance |
| `admin-history.ts` | Admin page for history editing — list, rename, hide, delete entries; non-destructive GPS point move/hide with per-point reset |
| `snipe.ts` | Stream sniping page — browser GPS routed to streamer location via Valhalla. Walking/cycling/car modes |
| `debug-location-pushes.ts` | Debug page showing recent companion location pushes with timestamps and telemetry |
| `weather-overlay.ts` | Weather overlay entry point |
| `types.ts` | TypeScript interfaces and discriminated unions mirroring `server/src/types.rs`. Manually kept in sync |
| `net.ts` | WebSocket lifecycle — connect to `ws(s)://host/ws`, JSON parse/send, exponential backoff reconnect (1s initial → 30s max). Supports client tags and `viewer=0` for non-viewer overlays |
| `state.ts` | Reactive store with pub/sub. Fields: `waypoints`, `location`, `route`, `liveRoute`, `connected`, `userCount`, `lastError`, `units`. `applyServerMessage()` dispatches by message type |
| `map.ts` | MapLibre wrapper — route polyline, numbered waypoint markers (draggable), streamer avatar marker, breadcrumb trails, context menus (right-click + mobile long-press), follow mode, reverse geocoding, POI popups |
| `sidebar.ts` | Left panel — header with status dots, "Add streamer location" button, undo/delete-all actions, history browser, waypoint input (coordinates / URLs / Plus Codes), SortableJS drag-reorder, per-leg route maneuvers, active/inactive toggles |
| `themes.ts` | Theme definitions (`THEMES`, `Theme` type), style JSON fetching, `applyTheme()` with raster fallback, PMTiles protocol registration. Shared across all pages |
| `settings.ts` | `SettingsPopup` class — modal overlay with theme `<select>` and per-measurement unit toggles (distance, speed, altitude) |
| `strings.ts` | Centralized UI strings object — all user-facing text, labels, and format templates |
| `units.ts` | Unit system — metric/imperial conversion, formatting helpers, `localStorage` persistence |
| `geo.ts` | Coordinate types (`LonLat`, `LatLon`), haversine distance calculation, distance formatting |
| `style.css` | Dark-themed CSS with custom properties, flexbox layout, responsive mobile sidebar overlay, settings popup styles |

For a deep technical walkthrough with sequence diagrams and state diagrams, read the root [`ARCHITECTURE.md`](../ARCHITECTURE.md).
