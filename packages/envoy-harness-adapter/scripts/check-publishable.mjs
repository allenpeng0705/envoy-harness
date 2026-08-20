/**
 * Pre-publish guard: block `npm publish` / `pnpm publish` while any
 * dependency is a local `link:` or `workspace:` spec.
 *
 * **Why:** this package deliberately uses `link:` deps during
 * development (self-contained cross-monorepo resolution — the
 * adapter can be opened from either repo without a workspace).
 * `link:` (and `workspace:`) specs do NOT resolve for registry
 * consumers: a published package with a `link:` dep is broken for
 * anyone who installs it from npm. This script turns that silent
 * failure into a loud, pre-publish error with a fix-it hint.
 *
 * **Usage:** `node scripts/check-publishable.mjs [path/to/package.json]`
 * (defaults to this package's `package.json`). Exit 0 = publishable;
 * exit 1 = block with the offending specs listed.
 *
 * **How to publish when the time comes:** replace each `link:`
 * spec with a version range (or `workspace:*` inside a published
 * workspace) before running `npm publish`. The EnvoyMesh packages
 * (`@envoymesh/protocol`, `@envoymesh/identity`,
 * `@envoymesh/agent-adapter`) must be published first.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultManifest = path.join(here, "..", "package.json");
const manifestPath = process.argv[2] ?? defaultManifest;

const raw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(raw);

const depGroups = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const offenders = [];
for (const group of depGroups) {
  const deps = manifest[group];
  if (!deps || typeof deps !== "object") continue;
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === "string" && (spec.startsWith("link:") || spec.startsWith("workspace:"))) {
      offenders.push(`${group}.${name} = "${spec}"`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `pre-publish check failed: ${manifest.name} has non-publishable local specs:\n` +
      offenders.map((o) => `  - ${o}`).join("\n") +
      "\nReplace them with version ranges (or workspace:* in a published workspace) " +
      "before publishing.",
  );
  process.exit(1);
}

console.log(`pre-publish check OK: ${manifest.name} has no link:/workspace: specs.`);
