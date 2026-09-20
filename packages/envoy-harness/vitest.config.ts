import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Some tests import this package by its own name
    // (`@envoymesh/envoy-harness`). Node's package self-reference resolves
    // that through `exports` to `./dist/index.js`, so those tests silently
    // tested the **built** artifact and failed to collect at all on a
    // clean checkout — `pnpm test` runs before `pnpm build`, so 17 files
    // errored on a fresh clone while passing on any machine that happened
    // to have a stale `dist/`. Point the name at the source instead:
    // tests must not depend on build state (design target #4).
    //
    // This matches only the bare specifier; `@envoymesh/envoy-harness-peer`
    // and friends are unaffected.
    alias: {
      "@envoymesh/envoy-harness": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
