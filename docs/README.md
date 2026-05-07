# KatMap Documentation

This directory contains topic-focused documentation for the KatMap codebase. Read files as needed — each covers a specific area of the project.

## Index

| File | What it covers | When to read |
|---|---|---|
| [codebase-overview.md](./codebase-overview.md) | File-by-file tour of server + client | Getting oriented in the repo |
| [build-and-dev.md](./build-and-dev.md) | Build commands, Nix shell, justfile | Running locally, building, type-checking |
| [wire-protocol.md](./wire-protocol.md) | WebSocket message types, data types, sync rules | Adding or changing message types |
| [companion-app.md](./companion-app.md) | Location tracking, TrailAccumulator, auto-complete, trail recovery | Working on location/trail/history |
| [theme-system.md](./theme-system.md) | Theme definitions, style fetching, PMTiles | Adding a new map theme |
| [patterns-and-gotchas.md](./patterns-and-gotchas.md) | Style replacement, broadcast model, polyline precision, active/inactive, units, strings | Debugging or adding features |
| [client-internals.md](./client-internals.md) | Reactive store, WebSocket client, map, sidebar, settings, themes, units, strings | Working on the frontend |
| [server-internals.md](./server-internals.md) | AppState, undo, broadcast, routes, live route, POI cache, debug endpoints | Working on the backend |
| [admin-pages.md](./admin-pages.md) | History editor, stream-sniping page, debug push viewer, CLI tool | Working on admin, snipe, or debug pages |

## Root-level docs

These files live at the repo root for quick access:

- **[../ARCHITECTURE.md](../ARCHITECTURE.md)** — Full technical walkthrough with sequence diagrams and design decisions
- **[../AGENTS.md](../AGENTS.md)** — Slim AI agent primer (auto-loaded into every agent session)
- **[../DEPLOY.md](../DEPLOY.md)** — Private deployment guide (VPS, Caddy, systemd, PMTiles)
- **[../README.md](../README.md)** — Project README (public-facing)
