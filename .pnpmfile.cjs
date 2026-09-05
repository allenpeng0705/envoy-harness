// Redirect @envoymesh/* internal packages to the sibling EnvoyMesh monorepo.
//
// Why this exists:
//   pnpm 10+ no longer reads `pnpm.overrides` from package.json; the new
//   home is `pnpm-workspace.yaml` `overrides:`. But the consumer packages
//   (`envoy-harness-adapter`, `envoy-harness-peer`) reach @envoymesh/* via
//   file: refs to ../EnvoyMesh/packages/<name>. Those file: refs only cover
//   direct deps; transitive deps (e.g. @envoymesh/agent-adapter declaring
//   @envoymesh/protocol@0.3.0) still hit the npm registry and 404 because
//   the package was never published there.
//
//   pnpmfile.cjs hook runs *before* lockfile resolution, so we can rewrite
//   any spec of @envoymesh/protocol|identity|agent-adapter to a local
//   workspace-relative path. We rewrite both the package itself (when it's
//   the package being installed) AND any *Dependencies fields that name
//   the redirected packages, so transitive resolution also stays local.
//
// Workspace layout assumed:
//   D:\mygithub\
//     EnvoyMesh\             <- this repo (sibling)
//     envoy-harness\         <- cwd when running pnpm install (this repo)

const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname);
const ENVOY_MESH_ROOT = path.resolve(WORKSPACE_ROOT, "..", "EnvoyMesh");

const REDIRECTS = {
  "@envoymesh/protocol": path.join(ENVOY_MESH_ROOT, "packages", "protocol"),
  "@envoymesh/identity": path.join(ENVOY_MESH_ROOT, "packages", "identity"),
  "@envoymesh/agent-adapter": path.join(ENVOY_MESH_ROOT, "packages", "agent-adapter"),
};

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function redirectSpec(depName) {
  if (REDIRECTS[depName]) {
    return `file:${REDIRECTS[depName].replace(/\\/g, "/")}`;
  }
  return undefined;
}

function readPackageHook(pkg, context) {
  if (!pkg) return pkg;

  // If this *is* one of the redirected packages, also rewrite its own
  // version so anything that refers to it (e.g. @envoymesh/agent-adapter
  // re-exported as a peer) installs from the sibling repo.
  if (pkg.name && REDIRECTS[pkg.name]) {
    pkg = {
      ...pkg,
      version: `file:${REDIRECTS[pkg.name].replace(/\\/g, "/")}`,
    };
  }

  // Rewrite any *Dependencies field that names one of the redirected
  // packages so pnpm never tries to fetch them from the registry.
  let mutated = false;
  const out = { ...pkg };
  for (const field of DEP_FIELDS) {
    const deps = out[field];
    if (!deps || typeof deps !== "object") continue;
    const rewritten = { ...deps };
    for (const depName of Object.keys(rewritten)) {
      const redirected = redirectSpec(depName);
      if (redirected && rewritten[depName] !== redirected) {
        rewritten[depName] = redirected;
        mutated = true;
      }
    }
    if (mutated) out[field] = rewritten;
  }
  return mutated || pkg !== out ? out : pkg;
}

module.exports = {
  hooks: {
    readPackage: readPackageHook,
  },
};
