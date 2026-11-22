/**
 * E2E-style coverage for Projects rail + scratch cwd chrome.
 *
 * Scratch is the default ACP session cwd, not a registered project.
 * These tests lock the grouping/display contract so it cannot show up
 * as a named project heading again.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { ContextStrip } from "../src/client/ContextStrip.js";
import { EmptyHero } from "../src/client/EmptyHero.js";
import { isWebUiScratchCwd } from "../src/client/path-display.js";
import {
  OTHER_PROJECT_LABEL,
  groupSessionsByProject,
  isRegisteredProjectCwd,
} from "../src/client/session-groups.js";
import type { SessionSummary } from "../src/client/acp/host-types.js";

const SCRATCH = "/Users/me/.envoy-harness/scratch";

function session(
  partial: Partial<SessionSummary> & Pick<SessionSummary, "id">,
): SessionSummary {
  return {
    cwd: SCRATCH,
    title: partial.title ?? partial.id,
    mtimeMs: partial.mtimeMs ?? 1,
    messageCount: partial.messageCount ?? 1,
    ...partial,
  };
}

describe("e2e: scratch is never a Projects heading", () => {
  it("registry empty → zero project groups (rail stays empty until manual add)", () => {
    const groups = groupSessionsByProject(
      [session({ id: "s1" }), session({ id: "s2", mtimeMs: 2 })],
      undefined,
      [],
      { includeUngrouped: true },
    );
    const projectGroups = groups.filter((g) => g.cwd !== "");
    const orphans = groups.find((g) => g.cwd === "")?.sessions ?? [];
    expect(projectGroups).toEqual([]);
    expect(orphans.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("keeps scratch out of named projects when real projects exist", () => {
    const groups = groupSessionsByProject(
      [
        session({ id: "scratch-1" }),
        session({
          id: "proj-1",
          cwd: "/Users/me/code/app",
          title: "app work",
          mtimeMs: 9,
        }),
      ],
      undefined,
      [{ path: "/Users/me/code/app", name: "app" }],
      { includeUngrouped: true },
    );
    const projectGroups = groups.filter((g) => g.cwd !== "");
    const orphans = groups.find((g) => g.cwd === "")?.sessions ?? [];
    expect(projectGroups.map((g) => g.label)).toEqual(["app"]);
    expect(projectGroups[0]?.sessions.map((s) => s.id)).toEqual(["proj-1"]);
    expect(orphans.map((s) => s.id)).toEqual(["scratch-1"]);
    expect(groups.map((g) => g.label)).toEqual(["app", OTHER_PROJECT_LABEL]);
  });

  it("does not treat scratch as a registered project cwd", () => {
    expect(isRegisteredProjectCwd(SCRATCH, [])).toBe(false);
    expect(
      isRegisteredProjectCwd(SCRATCH, [{ path: "/Users/me/code/app" }]),
    ).toBe(false);
    expect(isWebUiScratchCwd(SCRATCH)).toBe(true);
  });

  it("ignores scratch even if it was wrongly registered", () => {
    const groups = groupSessionsByProject(
      [session({ id: "s1" })],
      undefined,
      [{ path: SCRATCH, name: "scratch" }, { path: `${SCRATCH}/` }],
      { includeUngrouped: true },
    );
    expect(groups.filter((g) => g.cwd !== "")).toEqual([]);
    expect(isRegisteredProjectCwd(SCRATCH, [{ path: SCRATCH }])).toBe(false);
    expect(isRegisteredProjectCwd(`${SCRATCH}/`, [{ path: SCRATCH }])).toBe(
      false,
    );
  });
});

describe("e2e: ContextStrip hides scratch cwd chrome", () => {
  it("renders nothing for scratch-only context", () => {
    const html = renderToStaticMarkup(
      createElement(ContextStrip, {
        cwd: SCRATCH,
        cwdIsProject: false,
        attachedNames: [],
        touchedPaths: [],
      }),
    );
    expect(html).toBe("");
  });

  it("shows cwd only for registered project paths", () => {
    const html = renderToStaticMarkup(
      createElement(ContextStrip, {
        cwd: "/Users/me/code/app",
        cwdIsProject: true,
        attachedNames: [],
        touchedPaths: [],
      }),
    );
    expect(html).toContain("cwd");
    expect(html).toContain("app");
  });

  it("still hides scratch even if cwdIsProject is wrongly true", () => {
    const html = renderToStaticMarkup(
      createElement(ContextStrip, {
        cwd: SCRATCH,
        cwdIsProject: true,
        attachedNames: [],
        touchedPaths: [],
      }),
    );
    expect(html).toBe("");
  });
});

describe("e2e: EmptyHero project vs no-project copy", () => {
  it("no-project state never shows a path / scratch folder", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyHero, {
        ready: true,
        sessionId: "abcdef12-xxxx",
        projectName: null,
        onOpenProject: () => undefined,
      }),
    );
    expect(html).toContain("No project selected");
    expect(html).toContain("Open a project");
    expect(html).toContain("scratch folder");
    expect(html).not.toContain(SCRATCH);
    expect(html).not.toContain("Launch folder");
  });

  it("in-project state names the project and does not nag to add one", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyHero, {
        ready: true,
        sessionId: "abcdef12-xxxx",
        projectName: "my-app",
        onOpenProject: () => undefined,
      }),
    );
    expect(html).toContain("Working in");
    expect(html).toContain("my-app");
    expect(html).toContain("Switch project");
    expect(html).not.toContain("No project selected");
    expect(html).not.toContain("Open a project…");
  });
});
