# KatMap

Real-time collaborative route planner that tracks a streamer's live GPS location, lets multiple users manage waypoints simultaneously, and calculates pedestrian turn-by-turn directions.

Live at [katmap.awawawa.mov](https://katmap.awawawa.mov).

## Stack

- **Server**: Rust / Axum, WebSocket-based, authoritative over waypoint state
- **Client**: Vanilla TypeScript + Vite + MapLibre GL JS (no framework)
- **Routing**: Valhalla (Docker), pedestrian route planning plus car/cycling/walking stream-sniping routes
- **Tiles**: Self-hosted PMTiles vector tiles served by Caddy, 8 map themes + raster fallback
- **Location**: Companion app pushes GPS via REST API (altitude, accuracy, heading, speed)
- **History**: Stream breadcrumbs persisted to SQLite, browsable in the UI, and editable through an authenticated admin page

## Prerequisites

- [Nix](https://nixos.org/download.html) (provides gcc, pkg-config, openssl, rustc, cargo, nodejs, just)
- Docker + Docker Compose (for Valhalla)

All dev commands run through `nix-shell` via the justfile.

## Quick Start

```bash
# Start Valhalla (first run downloads + builds routing graph, takes ~10 min)
docker compose up -d

# Terminal 1: run the server (listens on 127.0.0.1:3001)
just dev-server

# Terminal 2: run the Vite dev server with HMR (proxies /ws to :3001)
just dev-client
```

The dev client runs at `http://localhost:5173`.

## Project Structure

```
katmap/
├── server/src/
│   ├── main.rs          # Axum setup, env vars, static file serving
│   ├── types.rs         # Serde message types (ClientMessage/ServerMessage)
│   ├── ws.rs            # WebSocket handler, AppState, undo stack
│   ├── companion.rs     # Companion app location push, ordered trail accumulation
│   ├── history.rs       # SQLite history persistence + authenticated web editor APIs
│   ├── snipe.rs         # Authenticated stream-sniping GPS route API/page
│   ├── valhalla.rs      # Valhalla route calculation proxy
│   ├── resolve.rs       # Google Maps short link resolution
│   └── admin.rs         # CLI tool for history DB maintenance
├── client/src/
│   ├── main.ts          # Entry point — wires state, net, map, sidebar
│   ├── types.ts         # TypeScript message types (mirrors server)
│   ├── net.ts           # WebSocket client with exponential backoff reconnect
│   ├── state.ts         # Reactive app state (pub/sub)
│   ├── map.ts           # MapLibre GL JS — themes, markers, route layer, context menu
│   ├── sidebar.ts       # Waypoint list, drag-reorder, route maneuvers, history browser
│   └── style.css        # Dark theme, responsive layout, all component styles
├── docker-compose.yml   # Valhalla routing engine
├── justfile             # Dev/build task runner
└── shell.nix            # Reproducible dev environment
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed codebase walkthrough.

## Justfile Commands

| Command | Description |
|---|---|
| `just dev-server` | Run Axum server in debug mode |
| `just dev-client` | Run Vite dev server with HMR + WebSocket proxy |
| `just build-client` | Production build to `client/dist/` |
| `just build-server` | Release build of the Rust server |
| `just build` | Build both client and server |
| `just check-client` | Type-check the client without emitting |

## Environment Variables (Server)

| Variable | Required | Description |
|---|---|---|
| `COMPANION_API_KEY` | **Yes** | API key for the companion location push endpoint |
| `VALHALLA_URL` | No | Valhalla routing engine URL (default: `http://127.0.0.1:8002`) |
| `WALKING_SPEED_KMH` | No | Pedestrian speed for route time estimates (default: `5.1`) |
| `DISPLAY_NAME` | No | Display name broadcast with location updates (default: `streamer`) |
| `HISTORY_DB_PATH` | No | SQLite database path for stream history (default: `/opt/katmap/history.db`) |
| `AVATAR_PATH` | No | Local image file served by `/api/avatar` (default: `/opt/katmap/avatar.png`) |
| `ADMIN_API_KEY` | No | Bearer token for `/admin/history`; falls back to `COMPANION_API_KEY` if unset |
| `SNIPING_API_KEY` | Yes for `/snipe` | Separate bearer token for stream-sniping APIs/page |
| `SOCIAL_DISCORD` | No | Discord URL; also enables `/discord` redirect |
| `SOCIAL_KICK` | No | Kick profile URL exposed by `/api/config` |
| `SOCIAL_TWITCH` | No | Twitch profile URL exposed by `/api/config` |
| `RUST_LOG` | No | Tracing filter (e.g. `info`, `katmap_server=debug`) |

## Companion App

Location data comes from a companion app that pushes GPS coordinates to the server via a REST API. The companion sends all [GeolocationCoordinates](https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates) properties:

- `lat`, `lon` — position (required)
- `accuracy` — position accuracy in meters
- `altitude` — altitude in meters above sea level
- `altitude_accuracy` — altitude accuracy in meters
- `heading` — direction in degrees (0° = north, clockwise)
- `speed` — velocity in meters per second

The server accepts location pushes at `POST /api/location` with `Authorization: Bearer <key>`. Sessions auto-start on the first location push and finalize after 15 minutes of inactivity (stale detection). Active trails are also saved on graceful shutdown. Points are sorted by their GPS timestamp, so out-of-order packets rebuild and rebroadcast the trail in chronological order.

## Admin / Private Pages

- `/admin/history` — authenticated history editor. It supports CLI-equivalent operations (list, rename, hide/unhide, delete) and non-destructive GPS cleanup. Original breadcrumbs remain in SQLite; hidden/moved point edits are stored separately in `trail_edits` and applied when `/api/history` is read.
- `/snipe` — authenticated stream-sniping GPS page. Browser GPS is routed to the streamer's current live location via Valhalla, with walking/cycling/car mode toggles. Auth uses `SNIPING_API_KEY`.

## Theme System

Adding a new map theme requires updating three files:

1. **`client/src/map.ts`** — Add the theme name to the `Theme` type and `THEME_FILE` map
2. **`client/src/main.ts`** — Add to the `VALID_THEMES` array
3. **`client/index.html`** — Add an `<option>` to the theme `<select>`

Style JSONs must reference the correct PMTiles source, glyph, and sprite URLs for your tile server.

## License

All rights reserved.
