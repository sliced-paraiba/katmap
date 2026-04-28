import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        adminHistory: resolve(__dirname, "admin-history.html"),
        snipe: resolve(__dirname, "snipe.html"),
      },
    },
  },
  server: {
    proxy: {
      "/ws": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:3001",
      },
    },
  },
});
