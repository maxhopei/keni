import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import deno from "@deno/vite-plugin";

const KENI_SERVER_URL = Deno.env.get("KENI_SERVER_URL") ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [deno(), react()],
  build: {
    outDir: "dist/",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: KENI_SERVER_URL,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/events": {
        target: KENI_SERVER_URL,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
