/**
 * U2 — screen renderer + layout helpers (hermetic, no TTY).
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  buildRailLine,
  buildStatusLine,
  fitLine,
  layoutRows,
  Screen,
} from "../src/screen.js";

function capture(): { stream: Writable; text: () => string } {
  let data = "";
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      data += chunk.toString("utf8");
      cb();
    },
  });
  return { stream, text: () => data };
}

/** Strip ANSI escapes so tests assert visible text. */
function visible(rendered: string): string {
  return rendered.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("fitLine", () => {
  it("truncates long lines with an ellipsis and pads short ones via layout", () => {
    expect(fitLine("hello", 10)).toBe("hello");
    expect(fitLine("hello world", 8)).toBe("hello w…");
    expect(fitLine("x", 1)).toBe("x");
    expect(fitLine("xy", 1)).toBe("…");
  });
});

describe("layoutRows", () => {
  it("lays out status, rail, transcript tail, and input within height", () => {
    const rows = layoutRows(
      {
        statusLine: "status",
        railLine: "rail",
        transcript: ["t1", "t2", "t3"],
        inputLine: "> prompt",
      },
      40,
      6,
    );
    expect(rows).toHaveLength(6);
    expect(rows[0]).toBe("status");
    expect(rows[1]).toBe("rail");
    // height 6 → used 2, transcript window 3
    expect(rows.slice(2, 5)).toEqual(["t1", "t2", "t3"]);
    expect(rows[5]).toBe("> prompt");
  });

  it("keeps only the bottom transcript window when it overflows", () => {
    const rows = layoutRows(
      {
        statusLine: "s",
        transcript: ["a", "b", "c", "d", "e"],
        inputLine: ">",
      },
      20,
      4,
    );
    // used 1, transcript window 2, input 1
    expect(rows).toEqual(["s", "d", "e", ">"]);
  });
});

describe("buildStatusLine", () => {
  it("shows session, model, cluster, and busy state", () => {
    expect(
      buildStatusLine({
        sessionId: "sess-1",
        model: "deepseek-chat",
        clusterConnected: 2,
        clusterTotal: 3,
        busy: true,
      }),
    ).toBe("envoy-harness · session sess-1 · model deepseek-chat · cluster 2/3 · busy");
  });

  it("falls back to em-dash model and ready", () => {
    expect(buildStatusLine({})).toBe("envoy-harness · model — · ready");
  });
});

describe("buildRailLine", () => {
  it("renders peers with model + health", () => {
    expect(
      buildRailLine([
        { id: "p1", model: "deepseek-chat", health: { ok: true, rttMs: 12 } },
        { id: "p2", health: { ok: false } },
      ]),
    ).toBe("peers: p1(deepseek-chat)[rtt=12ms]  p2[down]");
  });

  it("returns undefined for an empty cluster (no rail)", () => {
    expect(buildRailLine([])).toBeUndefined();
    expect(buildRailLine(undefined)).toBeUndefined();
  });
});

describe("Screen", () => {
  it("renders the full layout on first draw and skips unchanged rows on redraw", () => {
    const cap = capture();
    const screen = new Screen(cap.stream, { width: 40, height: 5 });
    const model = {
      statusLine: "status",
      railLine: "rail",
      transcript: ["t1"],
      inputLine: "> hi",
      inputCursor: 4,
    };
    screen.render(model);
    const first = cap.text();
    expect(visible(first)).toContain("status");
    expect(visible(first)).toContain("rail");
    expect(visible(first)).toContain("t1");
    expect(visible(first)).toContain("> hi");

    const before = cap.text().length;
    screen.render(model); // identical → only the cursor move is written
    const delta = cap.text().slice(before);
    expect(delta).toMatch(/^\x1b\[5;5H$/); // cursor reposition only
  });

  it("rewrites only the changed row when one line changes", () => {
    const cap = capture();
    const screen = new Screen(cap.stream, { width: 40, height: 5 });
    screen.render({
      statusLine: "s",
      railLine: "r",
      transcript: ["a"],
      inputLine: "> ",
    });
    const before = cap.text().length;
    screen.render({
      statusLine: "s",
      railLine: "r",
      transcript: ["b"], // changed row 3
      inputLine: "> ",
    });
    const delta = cap.text().slice(before);
    expect(delta).toContain("\x1b[3;1H");
    expect(delta).toContain("b");
  });

  it("wraps the status row with the accent color", () => {
    const cap = capture();
    const screen = new Screen(cap.stream, {
      width: 40,
      height: 5,
      accent: "\x1b[36m",
    });
    screen.render({
      statusLine: "status",
      transcript: [],
      inputLine: "> ",
    });
    const first = cap.text();
    expect(first).toContain("\x1b[36mstatus\x1b[0m");
  });
});
