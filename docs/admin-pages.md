# Admin & Debug Pages

KatMap has authenticated private pages, a debug diagnostics page, and a CLI maintenance tool.

## `/admin/history` — History Editor

An authenticated web interface for managing persisted stream history.

**Client entry point**: `client/src/admin-history.ts` + `client/admin-history.html`

**Auth**: `Authorization: Bearer <ADMIN_API_KEY>` (falls back to `COMPANION_API_KEY` if `ADMIN_API_KEY` is unset).

**API endpoints** (in `history.rs`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/history` | List all history entries |
| `PATCH` | `/api/admin/history/{id}` | Update entry (rename, hide/unhide) |
| `DELETE` | `/api/admin/history/{id}` | Delete an entry |
| `PUT` | `/api/admin/history/{id}/edits` | Save non-destructive trail edits |

**Features**:
- **List**: View all stream entries with date, duration, coordinate count, hidden status
- **Rename**: Edit stream titles
- **Hide/Unhide**: Toggle visibility of stream entries
- **Delete**: Remove entire stream entries from the database
- **GPS cleanup (non-destructive)**:
  - Hide individual breadcrumb points by index
  - Move individual breadcrumb points to new coordinates
  - Per-point reset (undo a single move/hide)
  - Discard all edits (restore original trail)

### Non-Destructive Edit Model

All edits are stored in the `trail_edits` JSON column:

```json
{
  "hidden_indices": [0, 5, 12],
  "moved_points": { "3": [-122.3321, 47.6062] }
}
```

The original `breadcrumbs` JSON is **never modified**. The public `/api/history` endpoint applies these edits at read time:

1. Omit entries at indices in `hidden_indices`
2. Replace coordinates at indices in `moved_points`

This makes all edits reversible.

## `/snipe` — Stream Sniping GPS

An authenticated page that routes the browser's GPS location to the streamer's current location via Valhalla.

**Client entry point**: `client/src/snipe.ts` + `client/snipe.html`

**Auth**: `Authorization: Bearer <SNIPING_API_KEY>` (separate from `COMPANION_API_KEY`).

**Endpoints** (in `snipe.rs`):
- `GET /api/snipe/status` — returns current streamer location
- `POST /api/snipe/route` — returns a route from browser GPS coordinates to the streamer's live location

**Transport modes** map to Valhalla costing modes:
- `pedestrian` → pedestrian routing
- `bicycle` → bicycle routing
- `auto` → auto routing

**Rate limiting**: The snipe route endpoint is rate-limited via `SnipeRouteLimiter`. Configured by `SNIPE_ROUTE_LIMIT_PER_MINUTE` (default: 30).

The server is stateless per request — multiple snipers do not share route state. Browser GPS coordinates are sent as JSON body with each route request.

## `/debug/location-pushes` — Companion Push Debugger

A debug page showing recent companion location pushes for diagnostics.

**Client entry point**: `client/src/debug-location-pushes.ts` + `client/debug-location-pushes.html`

**API endpoint**: `GET /api/debug/location-pushes` — returns:
- Server version info (commit, build time)
- Live session state (active, started_at, breadcrumb count)
- Latest location push with full payload and age
- Last 200 location pushes with received timestamps

No authentication required (intended for local debugging).

## Other Debug Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/version` | Compile-time metadata: `{ commit, build_time }` |
| `GET /api/health` | Server health: live status, breadcrumb count, last location age, connection count |

## `katmap-admin` — CLI Tool

A standalone binary (`server/src/admin.rs`, built as `katmap-admin`) for SQLite history maintenance. It reuses the shared history repository from the server library target.

**Usage**: Reads `HISTORY_DB_PATH` environment variable for the database path.

**Operations**:
- List all stream entries
- Hide/unhide entries
- Delete entries

The CLI is a minimal maintenance tool. For full functionality (GPS point editing, per-point reset), use the web-based `/admin/history` page.
