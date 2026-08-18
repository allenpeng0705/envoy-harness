/**
 * F9.2.1 tests — LSP types + NoopLspClient + MockLspClient
 * + StaticLspManager.
 *
 * Covers:
 * 1. `NoopLspClient` returns empty arrays / null.
 * 2. `NoopLspClient.close()` is a no-op (doesn't throw).
 * 3. `MockLspClient` returns scripted responses.
 * 4. `MockLspClient` records calls.
 * 5. `MockLspClient` rejects calls after `close()`.
 * 6. `MockLspClient.clearCalls()` resets the recorder.
 * 7. `StaticLspManager.forFile` routes by extension.
 * 8. `StaticLspManager.forFile` returns null for unknown
 *    extensions and for files without an extension.
 * 9. `StaticLspManager.forFile` honors literal-path
 *    overrides (keys starting with `/`).
 * 10. `StaticLspManager.closeAll` closes every distinct
 *     client and de-dupes (same client in 2 ext slots).
 * 11. `LspClient` is structurally satisfied by both
 *     `NoopLspClient` and `MockLspClient` (compile-time).
 */

import { describe, expect, it, vi } from "vitest";

import {
  MockLspClient,
  NoopLspClient,
  StaticLspManager,
  type LspClient,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
} from "@envoymesh/envoy-harness";

// ---------------------------------------------------------------------------
// NoopLspClient
// ---------------------------------------------------------------------------

describe("NoopLspClient", () => {
  it("definition / references return []", async () => {
    const c = new NoopLspClient();
    expect(await c.definition("/a.ts", 1, 2)).toEqual([]);
    expect(await c.references("/a.ts", 1, 2)).toEqual([]);
  });

  it("hover returns null", async () => {
    const c = new NoopLspClient();
    expect(await c.hover("/a.ts", 1, 2)).toBeNull();
  });

  it("diagnostics returns []", async () => {
    const c = new NoopLspClient();
    expect(await c.diagnostics("/a.ts")).toEqual([]);
  });

  it("close() is a no-op (doesn't throw, doesn't affect later calls)", async () => {
    const c = new NoopLspClient();
    await c.close();
    // NoopLspClient doesn't enforce "closed" — close is
    // a no-op; subsequent calls still return empty.
    expect(await c.definition("/a.ts", 0, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MockLspClient
// ---------------------------------------------------------------------------

describe("MockLspClient", () => {
  it("returns scripted responses by position key", async () => {
    const target: LspLocation = { file: "/def.ts", line: 10, column: 5 };
    const client = new MockLspClient({
      definitions: new Map([["/a.ts:5:3", [target]]]),
    });
    const got = await client.definition("/a.ts", 5, 3);
    expect(got).toEqual([target]);
  });

  it("returns [] for unknown position keys (silent no-op)", async () => {
    const client = new MockLspClient();
    expect(await client.definition("/a.ts", 5, 3)).toEqual([]);
    expect(await client.references("/a.ts", 5, 3)).toEqual([]);
    expect(await client.hover("/a.ts", 5, 3)).toBeNull();
    expect(await client.diagnostics("/a.ts")).toEqual([]);
  });

  it("hovers can return null explicitly via the map", async () => {
    const client = new MockLspClient({
      hovers: new Map([["/a.ts:1:1", null]]),
    });
    expect(await client.hover("/a.ts", 1, 1)).toBeNull();
    // But the map distinguishes "not in map" from "in map with null":
    expect(await client.hover("/b.ts", 1, 1)).toBeNull();
  });

  it("records every call in order", async () => {
    const client = new MockLspClient();
    await client.definition("/a.ts", 1, 2);
    await client.references("/a.ts", 3, 4);
    await client.hover("/a.ts", 5, 6);
    await client.diagnostics("/a.ts");
    expect(client.calls).toEqual([
      { op: "definition", file: "/a.ts", line: 1, column: 2 },
      { op: "references", file: "/a.ts", line: 3, column: 4 },
      { op: "hover", file: "/a.ts", line: 5, column: 6 },
      { op: "diagnostics", file: "/a.ts" },
    ]);
  });

  it("clearCalls() resets the recorder", async () => {
    const client = new MockLspClient();
    await client.definition("/a.ts", 1, 2);
    expect(client.calls).toHaveLength(1);
    client.clearCalls();
    expect(client.calls).toEqual([]);
  });

  it("rejects calls after close()", async () => {
    const client = new MockLspClient();
    await client.close();
    await expect(client.definition("/a.ts", 0, 0)).rejects.toThrow(/after close/);
    await expect(client.references("/a.ts", 0, 0)).rejects.toThrow(/after close/);
    await expect(client.hover("/a.ts", 0, 0)).rejects.toThrow(/after close/);
    await expect(client.diagnostics("/a.ts")).rejects.toThrow(/after close/);
  });

  it("diagnostics are keyed by file (not position)", async () => {
    const diag: LspDiagnostic = {
      file: "/a.ts",
      line: 0,
      column: 0,
      severity: "error",
      message: "boom",
    };
    const client = new MockLspClient({
      diagnostics: new Map([["/a.ts", [diag]]]),
    });
    const got = await client.diagnostics("/a.ts");
    expect(got).toEqual([diag]);
  });

  it("hover response is honored when in the map", async () => {
    const h: LspHover = {
      file: "/a.ts",
      line: 5,
      column: 3,
      contents: "function foo(): void",
    };
    const client = new MockLspClient({
      hovers: new Map([["/a.ts:5:3", h]]),
    });
    expect(await client.hover("/a.ts", 5, 3)).toEqual(h);
  });
});

// ---------------------------------------------------------------------------
// StaticLspManager
// ---------------------------------------------------------------------------

describe("StaticLspManager", () => {
  it("routes by file extension", () => {
    const ts = new MockLspClient();
    const py = new MockLspClient();
    const m = new StaticLspManager(
      new Map<string, LspClient>([
        [".ts", ts],
        [".tsx", ts],
        [".py", py],
      ]),
    );
    expect(m.forFile("/foo/bar.ts")).toBe(ts);
    expect(m.forFile("/foo/bar.tsx")).toBe(ts);
    expect(m.forFile("/foo/bar.py")).toBe(py);
  });

  it("returns null for unknown extensions", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    expect(m.forFile("/foo/bar.rs")).toBeNull();
  });

  it("returns null for files without an extension", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    expect(m.forFile("/foo/Makefile")).toBeNull();
    expect(m.forFile("/foo/.gitignore")).toBeNull();
  });

  it("returns null for hidden files (dotfile with no extension)", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    // `.eslintrc` has no extension after the last `.` because
    // the last `.` is at position 0 (the dotfile marker).
    expect(m.forFile("/foo/.eslintrc")).toBeNull();
  });

  it("literal-path keys (starting with /) override extension match", () => {
    const ts = new MockLspClient();
    const special = new MockLspClient();
    const m = new StaticLspManager(
      new Map<string, LspClient>([
        [".ts", ts],
        ["/foo/override.ts", special],
      ]),
    );
    expect(m.forFile("/foo/override.ts")).toBe(special);
    expect(m.forFile("/foo/other.ts")).toBe(ts);
  });

  it("closeAll() closes every distinct client", async () => {
    const a = new MockLspClient();
    const b = new MockLspClient();
    const closeA = vi.spyOn(a, "close");
    const closeB = vi.spyOn(b, "close");
    const m = new StaticLspManager(
      new Map<string, LspClient>([
        [".ts", a],
        [".tsx", a], // same client in two slots
        [".py", b],
      ]),
    );
    await m.closeAll();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("extension match is case-sensitive", () => {
    const ts = new MockLspClient();
    const m = new StaticLspManager(new Map([[".ts", ts]]));
    expect(m.forFile("/foo/bar.ts")).toBe(ts);
    expect(m.forFile("/foo/bar.TS")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Type-level: LspClient is satisfied by both NoopLspClient + MockLspClient
// ---------------------------------------------------------------------------

describe("LspClient is satisfied at the type level", () => {
  it("NoopLspClient is assignable to LspClient", () => {
    const c: LspClient = new NoopLspClient();
    expect(c).toBeInstanceOf(NoopLspClient);
  });

  it("MockLspClient is assignable to LspClient", () => {
    const c: LspClient = new MockLspClient();
    expect(c).toBeInstanceOf(MockLspClient);
  });
});
