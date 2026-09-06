import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      "@envoymesh/envoy-harness-ehui": path.resolve(
        root,
        "../envoy-harness-ehui/src/index.ts",
      ),
      "@envoymesh/envoy-harness-client/ehui": path.resolve(
        root,
        "../envoy-harness-client/src/ehui.ts",
      ),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(root, "index.html"),
    },
  },
});
