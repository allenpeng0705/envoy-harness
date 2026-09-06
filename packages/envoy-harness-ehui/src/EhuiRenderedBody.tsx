/**
 * Renders structured {@link EhuiLine} rows for Plan / Memory / Diff panels.
 */

import type { JSX } from "react";

import {
  buildGitDiffLines,
  buildMemoryLines,
  buildPlanLines,
  ehuiLineClassName,
  type EhuiLine,
} from "./ehui-render.js";

export interface EhuiRenderedBodyProps {
  panel: "plan" | "memory" | "git-diff";
  text: string;
  className?: string;
}

export function linesForPanel(
  panel: "plan" | "memory" | "git-diff",
  text: string,
): EhuiLine[] {
  if (panel === "plan") return buildPlanLines(text);
  if (panel === "memory") return buildMemoryLines(text);
  return buildGitDiffLines(text);
}

export function EhuiRenderedBody(props: EhuiRenderedBodyProps): JSX.Element {
  const lines = linesForPanel(props.panel, props.text);
  return (
    <div
      className={props.className ?? "ehui-body ehui-body--structured"}
      data-ehui-structured={props.panel}
    >
      {lines.map((line, i) => (
        <div key={i} className={ehuiLineClassName(line.kind)}>
          {line.text.length === 0 ? "\u00a0" : line.text}
        </div>
      ))}
    </div>
  );
}
