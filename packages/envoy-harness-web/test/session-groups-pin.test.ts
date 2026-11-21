import { describe, expect, it } from "vitest";
import { groupSessionsByProject } from "../src/client/session-groups.js";
import type { SessionSummary } from "../src/client/acp/host-types.js";

describe("groupSessionsByProject pins", () => {
  it("sorts pinned sessions first within a group", () => {
    const sessions: SessionSummary[] = [
      {
        id: "a",
        cwd: "/p",
        title: "old",
        mtimeMs: 1,
        messageCount: 1,
      },
      {
        id: "b",
        cwd: "/p",
        title: "pinned",
        mtimeMs: 2,
        messageCount: 2,
      },
    ];
    const groups = groupSessionsByProject(sessions, new Set(["a"]), [
      { path: "/p" },
    ]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
