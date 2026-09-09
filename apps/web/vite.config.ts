import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The console's dev server. **Same-origin with the API on purpose** (GRA-26): `/api` and `/mcp` are
 * proxied to the Hono server, so the browser talks to one origin and the session cookie never
 * crosses one — the shape production has, where `apps/server` serves this app's build itself
 * (`apps/server/src/console.ts`). `GRAFT_SERVER_URL` names the server for the proxy and is read
 * here, in Node, never in the browser; the default is where `pnpm --filter @graft/server dev`
 * listens. `GRAFT_CORS_ORIGIN` on the server still admits a console served from another origin,
 * which this configuration does not need.
 */
const server = process.env.GRAFT_SERVER_URL ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 3001,
    proxy: {
      "/api": { target: server, changeOrigin: true },
      "/mcp": { target: server, changeOrigin: true },
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
  ],
});
