/**
 * Phase G — skill catalog projection (deepseek's model-facing catalog,
 * envoy-native).
 *
 * Deepseek injects a durable "available skills" message so the model can
 * discover skills before loading them, and re-publishes it only when the
 * catalog digest changes. Envoy mirrors that: `renderSkillCatalog` is the
 * canonical `<available_skills>` block, `skillCatalogDigest` is the change
 * key, and `nextCatalogMessage` returns the replacement text only on
 * membership/description changes (stable prompt prefix → cache friendly).
 *
 * `createSkillCatalogFragment` wraps the catalog as a bounded
 * `ContextualUserFragment` for hosts that inject it as a user-role
 * fragment in their prompt assembly.
 */

import { createHash } from "node:crypto";

import {
  createBoundedFragment,
  type ContextualUserFragment,
} from "../context/fragment.js";
import type { SkillSummary } from "./types.js";

export interface SkillCatalogOptions {
  /** Max catalog entries (default 200). */
  maxEntries?: number;
  /** Per-entry description truncation in chars (default 240). */
  maxDescriptionChars?: number;
  /** Token cap for the bounded fragment (default 10_000). */
  tokenCap?: number;
}

/** Render the canonical `<available_skills>` catalog block. */
export function renderSkillCatalog(
  summaries: ReadonlyArray<SkillSummary>,
  options: SkillCatalogOptions = {},
): string {
  const maxEntries = options.maxEntries ?? 200;
  const maxDesc = options.maxDescriptionChars ?? 240;
  const sorted = [...summaries].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ["<available_skills>"];
  for (const s of sorted.slice(0, maxEntries)) {
    const desc =
      s.description.length > maxDesc
        ? `${s.description.slice(0, maxDesc)}…`
        : s.description;
    lines.push(`<skill name="${escapeXml(s.name)}">${escapeXml(desc)}</skill>`);
  }
  if (sorted.length > maxEntries) {
    lines.push(`<skill name="…">${sorted.length - maxEntries} more skills…</skill>`);
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Stable change key over the sorted name+description set. */
export function skillCatalogDigest(
  summaries: ReadonlyArray<SkillSummary>,
): string {
  const hash = createHash("sha256");
  for (const s of [...summaries].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${s.name}\u0000${s.description}\u0000`);
  }
  return hash.digest("hex");
}

/**
 * Deepseek's digest-based re-publish semantics: returns the catalog text
 * only when the digest changed since `prevDigest`, else empty.
 */
export function nextCatalogMessage(
  summaries: ReadonlyArray<SkillSummary>,
  prevDigest: string | undefined,
  options?: SkillCatalogOptions,
): { text: string; digest: string; changed: boolean } {
  const digest = skillCatalogDigest(summaries);
  if (digest === prevDigest) {
    return { text: "", digest, changed: false };
  }
  return {
    text: renderSkillCatalog(summaries, options),
    digest,
    changed: true,
  };
}

/** A bounded user-role fragment hosts can inject into prompt assembly. */
export function createSkillCatalogFragment(
  summaries: ReadonlyArray<SkillSummary>,
  options: SkillCatalogOptions = {},
): ContextualUserFragment {
  const text = renderSkillCatalog(summaries, options);
  return createBoundedFragment({
    id: "skill-catalog",
    owner: "skills",
    estimatedTokens: Math.ceil(text.length / 4),
    text,
    ...(options.tokenCap !== undefined ? { tokenCap: options.tokenCap } : {}),
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
