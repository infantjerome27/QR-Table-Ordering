import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React comes from a CDN import map (see index.html) so the app's own
// bundles stay small enough to deploy file-by-file. Pages are split
// into their own chunk for the same reason.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
      output: {
        manualChunks: (id) =>
          id.includes("/src/pages/") ? "pages" : "app",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/ws": { target: "ws://localhost:4000", ws: true },
    },
  },
});
