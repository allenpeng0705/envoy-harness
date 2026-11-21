import { describe, expect, it } from "vitest";
import {
  attachmentFootnote,
  buildPromptPayload,
  type DraftAttachment,
} from "../src/client/attachments.js";

function att(
  partial: Partial<DraftAttachment> & Pick<DraftAttachment, "kind" | "name">,
): DraftAttachment {
  return {
    id: partial.id ?? "1",
    name: partial.name,
    mimeType: partial.mimeType ?? "image/png",
    size: partial.size ?? 10,
    dataBase64: partial.dataBase64 ?? "AAAA",
    kind: partial.kind,
  };
}

describe("attachments", () => {
  it("builds text-only payload without images", () => {
    const p = buildPromptPayload("hi", [], [".envoy-attachments/a.txt"]);
    expect(p.text).toContain("hi");
    expect(p.text).toContain("Attached: .envoy-attachments/a.txt");
    expect(p.content).toBeUndefined();
  });

  it("builds content blocks for images", () => {
    const p = buildPromptPayload(
      "look",
      [att({ kind: "image", name: "x.png", mimeType: "image/png", dataBase64: "QQ==" })],
      [],
    );
    expect(p.content).toBeDefined();
    expect(p.content?.some((b) => b.type === "image")).toBe(true);
    expect(p.content?.some((b) => b.type === "text" && b.text.includes("look"))).toBe(
      true,
    );
  });

  it("formats footnote", () => {
    const note = attachmentFootnote(
      [att({ kind: "image", name: "x.png", mimeType: "image/jpeg" })],
      [".envoy-attachments/doc.pdf"],
    );
    expect(note).toContain("[image:image/jpeg]");
    expect(note).toContain("[file:.envoy-attachments/doc.pdf]");
  });
});
