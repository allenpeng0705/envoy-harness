import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    // Resolve the harness from source, not through `exports` → `dist`:
    // otherwise these tests only collect when someone has already run
    // `pnpm build`, and `pnpm -r run test` (which runs before build on a
    // clean checkout) fails to resolve the package.
    alias: {
      "@envoymesh/envoy-harness": path.resolve(
        root,
        "../envoy-harness/src/index.ts",
      ),
    },
  },
});
