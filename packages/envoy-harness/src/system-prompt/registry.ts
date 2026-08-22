/**
 * Phase G — system-prompt section registry + ordered renderer.
 */

import type {
  PromptAssemblyContext,
  PromptSection,
} from "./types.js";

export interface SystemPromptRegistry {
  /** Register a section. Duplicate names throw. Returns a disposer. */
  register(section: PromptSection): () => void;
  /** Registered sections in ascending order. */
  sections(): readonly PromptSection[];
  /**
   * Render the assembled system prompt: resolve every section's text in
   * ascending order and join with a blank line. A single `complete`
   * section becomes the sole content; more than one throws.
   */
  render(ctx?: PromptAssemblyContext): Promise<string>;
}

export function createSystemPromptRegistry(): SystemPromptRegistry {
  const sections = new Map<string, PromptSection>();
  const ordered = (): readonly PromptSection[] =>
    [...sections.values()].sort((a, b) => a.order - b.order);

  return {
    register(section) {
      if (sections.has(section.name)) {
        throw new Error(`system prompt section already registered: ${section.name}`);
      }
      sections.set(section.name, section);
      return () => {
        if (sections.get(section.name) === section) {
          sections.delete(section.name);
        }
      };
    },
    sections: ordered,
    async render(ctx = {}) {
      const resolved: Array<{
        name: string;
        text: string;
        complete: boolean | undefined;
      }> = [];
      for (const section of ordered()) {
        const text =
          typeof section.text === "string"
            ? section.text
            : await section.text(ctx);
        if (text.trim() === "") continue;
        resolved.push({ name: section.name, text, complete: section.complete });
      }
      const completes = resolved.filter((s) => s.complete === true);
      if (completes.length > 1) {
        throw new Error(
          `system prompt has ${completes.length} complete sections: ` +
            completes.map((s) => s.name).join(", "),
        );
      }
      if (completes.length === 1) return completes[0]!.text.trim();
      return resolved.map((s) => s.text.trim()).filter(Boolean).join("\n\n");
    },
  };
}
