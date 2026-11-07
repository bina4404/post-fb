import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist", emptyOutDir: true },
  // API chạy bằng `wrangler dev` ở cổng 8787.
  server: { proxy: { "/api": "http://localhost:8787" } },
});
