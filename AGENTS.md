# AI Agent Context

KatMap is a real-time collaborative route planner. Multiple users connect via WebSocket, see the same waypoints, and collaboratively plan pedestrian routes. The server is authoritative over all state. No waypoint persistence — state is in-memory. Stream history is persisted to SQLite.

Live at [katmap.awawawa.mov](https://katmap.awawawa.mov).

## Quick Orientation

- **Server** (`server/src/`): Rust/Axum — `main.rs` (setup, routes), `ws.rs` (WebSocket + AppState), `companion.rs` (location + trails), `history.rs` (SQLite), `snipe.rs`, `valhalla.rs`, `resolve.rs`, `poi.rs`, `debug.rs`
- **Client** (`client/src/`): Vanilla TypeScript + Vite + MapLibre GL — `main.ts` (entry), `map.ts`, `sidebar.ts`, `state.ts` (pub/sub store), `net.ts` (WS client), `themes.ts` (shared themes), `settings.ts`, `strings.ts`, `units.ts`, `geo.ts`
- **No framework**. Direct DOM manipulation.

## Build & Dev

```bash
docker compose up -d                      # Valhalla routing engine
just dev-server                           # Axum on :3001
just dev-client                           # Vite on :5173 (proxies /ws to :3001)
just build-client / just build-server     # Production builds
just check-client                         # Type-check only
```

Without `just`: use `nix-shell shell.nix --command "cd client && npm run build"` etc.

## Documentation

Detailed docs are in [`docs/`](docs/README.md). Key files:

| Doc | When to read |
|---|---|
| [docs/codebase-overview.md](docs/codebase-overview.md) | Getting oriented — file-by-file tour |
| [docs/build-and-dev.md](docs/build-and-dev.md) | Build commands, Nix, Valhalla setup |
| [docs/wire-protocol.md](docs/wire-protocol.md) | WebSocket message types, sync rules |
| [docs/theme-system.md](docs/theme-system.md) | Adding a map theme (one file: `themes.ts`) |
| [docs/patterns-and-gotchas.md](docs/patterns-and-gotchas.md) | Style replacement, broadcast model, polyline precision, active/inactive, undo |
| [docs/client-internals.md](docs/client-internals.md) | Frontend architecture |
| [docs/server-internals.md](docs/server-internals.md) | Backend architecture |
| [docs/companion-app.md](docs/companion-app.md) | Location tracking, auto-complete, trail recovery |
| [docs/admin-pages.md](docs/admin-pages.md) | Admin history editor, snipe, debug pages |

Root-level docs: [`ARCHITECTURE.md`](ARCHITECTURE.md) (full walkthrough), [`DEPLOY.md`](DEPLOY.md) (private, deployment), [`README.md`](README.md) (public-facing).

## Key Design Decisions

- **Broadcast-only**: all server messages go to all clients. No per-client messaging.
- **Server-authoritative**: clients send mutations, server echoes full state.
- **Undo on server**: shared undo stack, capped at 50 entries, no redo.
- **No waypoint persistence**: waypoints and undo are in-memory only.
- **Stream history persisted**: breadcrumb trails saved to SQLite with full telemetry.
- **Polyline precision-6**: Valhalla uses precision-6, not Google's precision-5.
- **Active/inactive waypoints**: `Waypoint.active` field controls route inclusion. Auto-complete deactivates waypoints the streamer passes through.
