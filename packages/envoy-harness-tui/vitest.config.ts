import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@envoymesh/envoy-harness": path.resolve(
        root,
        "../envoy-harness/src/index.ts",
      ),
      "@envoymesh/envoy-harness-client": path.resolve(
        root,
        "../envoy-harness-client/src/index.ts",
      ),
    },
  },
});
