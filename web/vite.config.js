import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In local development /api is proxied to the Functions host (func start).
// In Azure, VITE_API_BASE is set at build time to the function app URL.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:7071" } },
});
