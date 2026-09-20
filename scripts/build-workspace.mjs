#!/usr/bin/env node
/**
 * Build every workspace package in dependency order.
 *
 * **Why this exists instead of `pnpm -r run build`.** pnpm 10 does not wait
 * for a package's dependencies before starting its build — with the default
 * concurrency, dependents and dependencies start together. Every package
 * here resolves its siblings' *declarations* through `exports` →
 * `dist/index.d.ts`, so a package that starts before its dependency has
 * emitted fails with `TS2307: Cannot find module`, and the whole recursive
 * run aborts. Measured directly: `pnpm -r run build` (and
 * `--workspace-concurrency=1`, and `--sort`, and declaring the deps with the
 * `workspace:` protocol instead of `file:`) all still start dependents too
 * early on a clean checkout.
 *
 * So the order is computed here, from what the sources actually import:
 *
 * 1. Scan each package's `src/**` for **build-time** references —
 *    `from "@envoymesh/<pkg>"` (value or type) and literal
 *    `import("@envoymesh/<pkg>")` type queries. A dynamic import whose
 *    specifier is a *variable* is deliberately invisible here: that is how
 *    the optional companion packages (cordis, peer, tui) are loaded, and
 *    keeping them out of the graph is what makes a clean build possible.
 * 2. Topologically sort. A cycle in this graph is a hard error (it would
 *    mean a real mutual build dependency), reported with the offending
 *    edges rather than silently mis-scheduled.
 * 3. Build one level at a time, in parallel within a level.
 *
 * Usage: `node scripts/build-workspace.mjs` (or `pnpm run build`).
 * `--graph` prints the derived graph and order without building.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listPackages() {
  const out = [];
  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PACKAGES_DIR, entry.name);
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    out.push({ dir, name: pkg.name, manifest, hasSrc: fs.existsSync(path.join(dir, "src")) });
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Build-time workspace references of one package (by package name). */
function referencesOf(pkg, known) {
  const deps = new Set();
  if (!pkg.hasSrc) return deps;
  // `@envoymesh/<name>` with an optional subpath (`.../envoy-harness-client/ehui`).
  // The captured group is the package name only; the subpath is ignored.
  const staticFrom =
    /from\s+"(@envoymesh\/[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._/-]+)?"/g;
  const dynamicLiteral =
    /import\(\s*"(@envoymesh\/[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._/-]+)?"\s*\)/g;
  for (const file of walk(path.join(pkg.dir, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(staticFrom)) {
      if (known.has(m[1])) deps.add(m[1]);
    }
    // Literal dynamic import / type query. `import(variable)` never matches,
    // which is the point: optional companions stay out of the graph.
    for (const m of text.matchAll(dynamicLiteral)) {
      if (known.has(m[1])) deps.add(m[1]);
    }
  }
  return deps;
}

/** Level-by-level order. Throws with the edge list when the graph cycles. */
export function topoLevels(nodes) {
  const remaining = new Map(nodes.map((n) => [n.name, new Set(n.deps)]));
  const levels = [];
  const done = new Set();
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => done.has(d)))
      .map(([name]) => name);
    if (ready.length === 0) {
      const cycle = [...remaining.entries()]
        .map(([name, deps]) => `  ${name} -> ${[...deps].filter((d) => remaining.has(d)).join(", ")}`)
        .join("\n");
      throw new Error(
        `build graph has a cycle (a package cannot build before itself):\n${cycle}`,
      );
    }
    // Deterministic within a level so the log is stable.
    ready.sort();
    for (const name of ready) {
      remaining.delete(name);
      done.add(name);
    }
    levels.push(ready);
  }
  return levels;
}

function main() {
  const packages = listPackages();
  const known = new Set(packages.map((p) => p.name));
  const nodes = packages.map((p) => ({ ...p, deps: referencesOf(p, known) }));

  let levels;
  try {
    levels = topoLevels(nodes);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  if (process.argv.includes("--graph")) {
    for (const n of nodes) {
      process.stdout.write(
        `${n.name} -> ${[...n.deps].sort().join(", ") || "(no workspace deps)"}\n`,
      );
    }
    process.stdout.write(
      `\norder:\n${levels.map((l, i) => `  ${i + 1}. ${l.join(", ")}`).join("\n")}\n`,
    );
    return;
  }

  for (const [index, level] of levels.entries()) {
    process.stdout.write(
      `\n[build] level ${index + 1}/${levels.length}: ${level.join(", ")}\n`,
    );
    // One pnpm invocation per level (`--filter a --filter b run build`), so a
    // failure stops before the next level instead of cascading.
    const filterArgs = level.flatMap((name) => ["--filter", name]);
    try {
      execFileSync("pnpm", [...filterArgs, "run", "build"], {
        cwd: ROOT,
        stdio: "inherit",
      });
    } catch {
      process.stderr.write(
        `\n[build] failed in level ${index + 1}: ${level.join(", ")}\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write("\n[build] all workspace packages built\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
