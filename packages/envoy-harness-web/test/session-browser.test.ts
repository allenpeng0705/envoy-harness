import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/client/acp/host-types.js";
import {
  filterSessions,
  formatSessionWhen,
  sessionMatchesQuery,
  visibleSessions,
} from "../src/client/session-groups.js";

function sess(
  partial: Partial<SessionSummary> & Pick<SessionSummary, "id">,
): SessionSummary {
  return {
    mtimeMs: 0,
    messageCount: 0,
    ...partial,
  };
}

describe("session browser helpers", () => {
  const rows = [
    sess({
      id: "abc-111",
      title: "Fix login",
      cwd: "/Users/me/app",
      messageCount: 4,
      mtimeMs: 1_000,
    }),
    sess({
      id: "def-222",
      title: "Refactor mesh",
      cwd: "/work/envoy",
      messageCount: 12,
      mtimeMs: 2_000,
    }),
  ];

  it("matches title, id, or cwd", () => {
    expect(sessionMatchesQuery(rows[0]!, "login")).toBe(true);
    expect(sessionMatchesQuery(rows[0]!, "ABC")).toBe(true);
    expect(sessionMatchesQuery(rows[0]!, "/users/me")).toBe(true);
    expect(sessionMatchesQuery(rows[0]!, "envoy")).toBe(false);
    expect(filterSessions(rows, "mesh").map((s) => s.id)).toEqual(["def-222"]);
    expect(filterSessions(rows, "  ").length).toBe(2);
  });

  it("hides archived unless showArchived", () => {
    const archived = new Set(["abc-111"]);
    expect(visibleSessions(rows, archived, false).map((s) => s.id)).toEqual([
      "def-222",
    ]);
    expect(visibleSessions(rows, archived, true).map((s) => s.id)).toEqual([
      "abc-111",
      "def-222",
    ]);
  });

  it("formats relative mtime", () => {
    const now = Date.parse("2026-01-15T12:00:00Z");
    expect(formatSessionWhen(now - 30_000, now)).toBe("just now");
    expect(formatSessionWhen(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatSessionWhen(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatSessionWhen(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatSessionWhen(0, now)).toBe("");
  });
});
