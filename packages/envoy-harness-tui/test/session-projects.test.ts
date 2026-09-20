/**
 * `/project` handlers against a fake client — hermetic (no ACP, no TTY).
 */

import { describe, expect, it, vi } from "vitest";

import type {
  ClientWorkspaceEntry,
  EnvoyHarnessClient,
} from "@envoymesh/envoy-harness-client";

import type { SessionWorkspaceCtx } from "../src/session-context.js";
import { runProjectImpl } from "../src/session-projects.js";
import { newSessionImpl } from "../src/session-workspace.js";
import type { TranscriptLine, TranscriptRole } from "../src/transcript.js";

const ENTRIES: ClientWorkspaceEntry[] = [
  { path: "/p/one", name: "one", addedAt: "2026-01-01T00:00:00.000Z" },
  {
    path: "/p/two",
    name: "two",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-02T00:00:00.000Z",
  },
];

interface Harness {
  ctx: SessionWorkspaceCtx;
  pushed: Array<{ role: TranscriptRole; text: string }>;
  lines: TranscriptLine[];
  renders: { count: number };
}

function harness(client: Record<string, unknown>): Harness {
  const pushed: Array<{ role: TranscriptRole; text: string }> = [];
  const lines: TranscriptLine[] = [
    { role: "user", text: "stale", at: "2026-01-01T00:00:00.000Z" },
  ];
  const renders = { count: 0 };
  const ctx: SessionWorkspaceCtx = {
    push: (role, text) => {
      pushed.push({ role, text });
    },
    client: client as unknown as EnvoyHarnessClient,
    sessionId: "sess-old",
    busy: false,
    cwd: undefined,
    initialAutoRun: undefined,
    lines,
    onTranscript: () => {
      renders.count++;
    },
    turnSeen: new Set<string>(["old"]),
    lastTurnCostUsd: 0.5,
    gitDiffStaged: false,
    gitDiffStat: false,
  };
  return { ctx, pushed, lines, renders };
}

function text(h: Harness): string {
  return h.pushed.map((p) => p.text).join("\n");
}

describe("/project list", () => {
  it("renders name, full path, and last use", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const h = harness({ listWorkspaces });
    await runProjectImpl(h.ctx, "list");
    expect(text(h)).toContain("Projects (2)");
    expect(text(h)).toContain("/p/one");
    expect(text(h)).toContain("/p/two");
    expect(text(h)).toContain("last used 2026-01-02T00:00:00.000Z");
  });

  it("reports a client error as a status line", async () => {
    const listWorkspaces = vi.fn(async () => {
      throw new Error("registry not wired");
    });
    const h = harness({ listWorkspaces });
    await expect(runProjectImpl(h.ctx, "list")).resolves.toBeUndefined();
    expect(text(h)).toContain("project list failed: registry not wired");
  });
});

describe("/project add", () => {
  it("passes the path and display name to the client", async () => {
    const added: ClientWorkspaceEntry = {
      path: "/abs/path",
      name: "My Name",
      addedAt: "2026-01-01T00:00:00.000Z",
    };
    const addWorkspace = vi.fn(async () => added);
    const h = harness({ addWorkspace });
    await runProjectImpl(h.ctx, "add", "/abs/path", "My Name");
    expect(addWorkspace).toHaveBeenCalledWith("/abs/path", "My Name");
    expect(text(h)).toContain("added project My Name → /abs/path");
  });

  it("surfaces a rejected path as a status line", async () => {
    const addWorkspace = vi.fn(async () => {
      throw new Error("path is not absolute");
    });
    const h = harness({ addWorkspace });
    await expect(
      runProjectImpl(h.ctx, "add", "relative/path"),
    ).resolves.toBeUndefined();
    expect(text(h)).toContain("project add failed: path is not absolute");
  });
});

describe("/project remove", () => {
  it("reports removed and not-found results", async () => {
    const removeWorkspace = vi.fn(async () => true);
    const h = harness({ removeWorkspace });
    await runProjectImpl(h.ctx, "remove", "/p/one");
    expect(removeWorkspace).toHaveBeenCalledWith("/p/one");
    expect(text(h)).toContain("removed project /p/one");

    const miss = harness({ removeWorkspace: vi.fn(async () => false) });
    await runProjectImpl(miss.ctx, "remove", "/p/nope");
    expect(text(miss)).toContain("not in the project registry: /p/nope");
  });

  it("surfaces a client error as a status line", async () => {
    const removeWorkspace = vi.fn(async () => {
      throw new Error("registry not wired");
    });
    const h = harness({ removeWorkspace });
    await expect(
      runProjectImpl(h.ctx, "remove", "/p/one"),
    ).resolves.toBeUndefined();
    expect(text(h)).toContain("project remove failed: registry not wired");
  });
});

describe("/project open", () => {
  it("opens by index against the most recently listed order", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const setSessionPolicy = vi.fn(async () => undefined);
    const h = harness({ listWorkspaces, acpNewSession, setSessionPolicy });

    await runProjectImpl(h.ctx, "list");
    await runProjectImpl(h.ctx, "open", "2");

    expect(acpNewSession).toHaveBeenCalledWith({ cwd: "/p/two" });
    expect(h.ctx.sessionId).toBe("sess-new");
    expect(h.ctx.lines).toHaveLength(0);
    expect(h.ctx.turnSeen.size).toBe(0);
    expect(h.ctx.lastTurnCostUsd).toBeUndefined();
    expect(h.renders.count).toBe(1);
    expect(text(h)).toContain("new session (project two) sess-new");
  });

  it("accepts an exact path", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const h = harness({ listWorkspaces, acpNewSession });

    await runProjectImpl(h.ctx, "open", "/p/one");

    expect(acpNewSession).toHaveBeenCalledWith({ cwd: "/p/one" });
  });

  it("makes the opened project stick for a later /new", async () => {
    // Without this, `/project open` followed by `/new` would silently fall
    // back to the process cwd and the user would be in a different project
    // than the one they just chose.
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const h = harness({ listWorkspaces, acpNewSession });

    await runProjectImpl(h.ctx, "open", "/p/two");
    acpNewSession.mockClear();
    await newSessionImpl(h.ctx);

    expect(acpNewSession).toHaveBeenCalledWith({ cwd: "/p/two" });
  });

  it("falls back to the process cwd when no project was opened", async () => {
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const h = harness({ acpNewSession });
    h.ctx.cwd = "/process/cwd";
    // A distinct client so the active-project map from other tests cannot
    // bleed in.
    await newSessionImpl(h.ctx);
    expect(acpNewSession).toHaveBeenCalledWith({ cwd: "/process/cwd" });
  });

  it("forgets the active project when it is removed", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const removeWorkspace = vi.fn(async () => true);
    const h = harness({ listWorkspaces, acpNewSession, removeWorkspace });

    await runProjectImpl(h.ctx, "open", "/p/two");
    await runProjectImpl(h.ctx, "remove", "/p/two");
    acpNewSession.mockClear();
    await newSessionImpl(h.ctx);

    // Back to the process cwd rather than a project that no longer exists
    // in the registry.
    expect(acpNewSession).toHaveBeenCalledWith(undefined);
  });

  it("fetches the list when open runs before list", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const h = harness({ listWorkspaces, acpNewSession });
    await runProjectImpl(h.ctx, "open", "1");
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(acpNewSession).toHaveBeenCalledWith({ cwd: "/p/one" });
  });

  it("rejects an out-of-range index and an unknown path", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => ({ sessionId: "sess-new" }));
    const h = harness({ listWorkspaces, acpNewSession });

    await runProjectImpl(h.ctx, "open", "5");
    expect(text(h)).toContain("index 5 out of range (1-2)");
    await runProjectImpl(h.ctx, "open", "/nope");
    expect(text(h)).toContain("no registered project with path /nope");
    expect(acpNewSession).not.toHaveBeenCalled();
  });

  it("surfaces a session-creation error as a status line", async () => {
    const listWorkspaces = vi.fn(async () => ENTRIES);
    const acpNewSession = vi.fn(async () => {
      throw new Error("host rejected cwd");
    });
    const h = harness({ listWorkspaces, acpNewSession });
    await expect(runProjectImpl(h.ctx, "open", "1")).resolves.toBeUndefined();
    expect(text(h)).toContain("new session failed: host rejected cwd");
  });
});
