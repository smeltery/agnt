import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// agnt-web is a static SPA that talks to a self-hosted agnt relay over WSS + HTTPS.
// It can be served by any static host (nginx, Caddy, S3+CloudFront, Tailscale Funnel, …).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
