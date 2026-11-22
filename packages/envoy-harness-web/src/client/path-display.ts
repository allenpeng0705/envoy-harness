/**
 * Cross-platform path display helpers (macOS + Windows).
 */

/** Normalize separators for comparison (Windows drive letters kept). */
export function normalizePathKey(p: string): string {
  const trimmed = p.trim();
  if (trimmed.length === 0) return "";
  let withSlashes = trimmed.replace(/\\/g, "/");
  // Drop trailing separators so `/foo/` and `/foo` compare equal (keep `/`).
  if (withSlashes.length > 1) {
    withSlashes = withSlashes.replace(/\/+$/, "");
  }
  // Windows drive letter case-fold for equality.
  if (/^[a-zA-Z]:\//.test(withSlashes)) {
    return withSlashes.charAt(0).toUpperCase() + withSlashes.slice(1);
  }
  return withSlashes;
}

/** Short label for chrome (basename + parent), works for / and \\ paths. */
export function shortPathLabel(p: string, maxLen = 48): string {
  const n = normalizePathKey(p);
  if (n.length === 0) return "cwd";
  if (n.length <= maxLen) return n;
  const parts = n.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return `…${n.slice(-(maxLen - 1))}`;
  }
  const last = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2]!;
  const label = `…/${parent}/${last}`;
  return label.length <= maxLen ? label : `…/${last}`;
}

/** True when two absolute paths refer to the same directory. */
export function pathsEqual(a: string, b: string): boolean {
  return normalizePathKey(a) === normalizePathKey(b);
}

/**
 * Default WebUI ACP cwd (`~/.envoy-harness/scratch`) — a session working
 * directory, **not** a registered project. Used so chrome does not treat
 * scratch as a project name/path.
 */
export function isWebUiScratchCwd(cwd: string): boolean {
  const n = normalizePathKey(cwd).toLowerCase();
  if (n.length === 0) return false;
  return (
    n.endsWith("/.envoy-harness/scratch") ||
    n === ".envoy-harness/scratch" ||
    /\/\.envoy-harness\/scratch$/i.test(n)
  );
}

/** Detect mod key: Meta on macOS, Ctrl elsewhere. */
export function isPrimaryMod(e: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform ?? "";
    if (/Mac|iPhone|iPad/.test(platform)) return e.metaKey;
  }
  return e.ctrlKey;
}
