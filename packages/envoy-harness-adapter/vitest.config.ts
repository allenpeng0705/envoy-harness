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
    // Same reason as the other sibling packages: resolve the harness by
    // its source, not through `exports` → `dist`. Without this the adapter
    // suites only collect when someone has already run `pnpm build`, so a
    // clean checkout (`pnpm test` before `pnpm build`) fails to collect.
    alias: {
      "@envoymesh/envoy-harness": path.resolve(
        root,
        "../envoy-harness/src/index.ts",
      ),
    },
  },
});
