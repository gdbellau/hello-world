import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        game: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "admin/index.html"),
      },
    },
  },
  server: {
    // `npm run dev` serves the client only; point API calls at `wrangler dev` if it's running.
    proxy: { "/api": "http://127.0.0.1:8787", "/admin/api": "http://127.0.0.1:8787" },
  },
});
