# Build & Development

## Prerequisites

- [Nix](https://nixos.org/download.html) — provides reproducible dev dependencies (gcc, pkg-config, openssl, rustc, cargo, nodejs, just)
- Docker + Docker Compose — for the Valhalla routing engine

All dev commands run through `nix-shell` (wrapped by the justfile).

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

## Justfile Commands

| Command | Description |
|---|---|
| `just dev-server` | Run Axum server in debug mode (`cargo run`) |
| `just dev-client` | Run Vite dev server with HMR + WebSocket proxy |
| `just build-client` | Production build to `client/dist/` |
| `just build-server` | Release build of the Rust server |
| `just build` | Build both client and server |
| `just check-client` | Type-check the client without emitting (`tsc --noEmit`) |

## Running Without Just

If `just` is not available in your PATH (common in agent environments), use `nix-shell` directly:

```bash
# Build client
nix-shell shell.nix --command "cd client && npm run build"

# Build server
nix-shell shell.nix --command "cd server && cargo build --release"

# Type-check client
nix-shell shell.nix --command "cd client && npx tsc --noEmit"

# Dev server
nix-shell shell.nix --command "cd server && cargo run"

# Dev client
nix-shell shell.nix --command "cd client && npm run dev"
```

## Nix Shell

The file `shell.nix` provides a reproducible development environment:

```nix
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  buildInputs = with pkgs; [
    gcc pkg-config openssl rustc cargo nodejs just
  ];
  OPENSSL_DIR = "${pkgs.openssl.dev}";
  OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
}
```

The `OPENSSL_*` environment variables are needed for the Rust `openssl` crate to find its native dependency.

## Valhalla (Docker)

The routing engine runs in Docker via `docker-compose.yml`. The first start downloads OSM data and builds the routing graph — this can take 10+ minutes. After the initial build, subsequent starts are fast.

Useful Docker commands:
```bash
docker compose up -d              # Start Valhalla
docker compose down               # Stop Valhalla
docker logs -f katmap-valhalla-1  # Follow Valhalla logs
curl -sf http://localhost:8002/status  # Health check
```

If you change `tile_urls` in `docker-compose.yml`, you must delete the volume to force a full rebuild:
```bash
docker compose down
docker volume rm katmap_valhalla-data
docker compose up -d
```
