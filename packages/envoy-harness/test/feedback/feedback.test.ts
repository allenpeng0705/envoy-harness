/**
 * Phase D / Item 16 — feedback store + sidecar + no-injection.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFeedbackSidecar,
  createFeedbackStore,
  toSelfEvolveSignals,
} from "../../src/feedback/index.js";

describe("feedback", () => {
  it("records append-only events (immutable log)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fb-"));
    const store = createFeedbackStore({ dir });
    const a = await store.record({
      sessionId: "s1",
      polarity: "up",
      note: "SECRET_NOTE_NEVER_INJECT",
      score: 0.8,
    });
    const b = await store.record({
      sessionId: "s1",
      polarity: "down",
      messageIndex: 2,
    });
    expect(a.id).not.toBe(b.id);
    const listed = await store.list("s1");
    expect(listed).toHaveLength(2);

    const raw = await readFile(store.logPath, "utf8");
    expect(raw).toContain("SECRET_NOTE_NEVER_INJECT");
    // No delete API — immutability.
    expect(typeof (store as { delete?: unknown }).delete).toBe("undefined");
  });

  it("sidecar supports put / list / delete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fb-side-"));
    const sessionFile = path.join(dir, "sess.jsonl");
    const side = createFeedbackSidecar({ sessionFilePath: sessionFile });
    await side.put({ messageIndex: 0, polarity: "up", note: "nice" });
    await side.put({ messageIndex: 1, polarity: "down", score: -0.5 });
    let all = await side.list();
    expect(all).toHaveLength(2);
    await side.put({ messageIndex: 0, polarity: "neutral" });
    all = await side.list();
    expect(all.find((e) => e.messageIndex === 0)?.polarity).toBe("neutral");
    expect(await side.delete(1)).toBe(true);
    expect(await side.list()).toHaveLength(1);
  });

  it("toSelfEvolveSignals never includes raw note text", () => {
    const signals = toSelfEvolveSignals([
      {
        id: "1",
        ts: "2026-01-01T00:00:00.000Z",
        sessionId: "s",
        polarity: "up",
        note: "RAW_SHOULD_NOT_APPEAR",
        score: 1,
      },
    ]);
    expect(signals).toHaveLength(1);
    expect(JSON.stringify(signals)).not.toContain("RAW_SHOULD_NOT_APPEAR");
    expect(signals[0]?.score).toBe(1);
    expect("note" in signals[0]!).toBe(false);
  });
});
