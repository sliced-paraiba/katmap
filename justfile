# KatMap justfile

# Run the Axum server in dev mode
dev-server:
    nix-shell shell.nix --command "cd server && cargo run"

# Run the Vite dev server with HMR
dev-client:
    nix-shell shell.nix --command "cd client && npm run dev"

# Build the client for production
build-client:
    nix-shell shell.nix --command "cd client && npm run build"

# Build the server for release
build-server:
    nix-shell shell.nix --command "cd server && cargo build --release"

# Build everything
build: build-client build-server

# Type-check the client
check-client:
    nix-shell shell.nix --command "cd client && npx tsc --noEmit"
