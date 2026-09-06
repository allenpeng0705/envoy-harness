/**
 * Permission and user-question handling for TuiSession.
 */

import { buildPermissionPreview } from "./permission-preview.js";
import type {
  PermissionRequest,
  UserQuestionAnswer,
  UserQuestionRequest,
} from "./session-types.js";
import type { PushFn } from "./session-context.js";
import {
  clampPermissionPreviewOffset,
  formatPermissionBlock,
  type TranscriptFormatOptions,
} from "./transcript.js";

export type PermissionWaiter = {
  req: PermissionRequest;
  resolve: (d: "allow" | "deny") => void;
  preview?: string;
  previewOffset: number;
};

export type UserQuestionWaiter = {
  req: UserQuestionRequest;
  resolve: (a: UserQuestionAnswer) => void;
};

export function handlePermissionRequestImpl(
  req: PermissionRequest,
  opts: {
    onPermission?: ((req: PermissionRequest) => Promise<"allow" | "deny">) | undefined;
    push: PushFn;
    cwd: string | undefined;
    transcriptFormat: TranscriptFormatOptions;
    setWaiter: (w: PermissionWaiter | undefined) => void;
    getWaiter: () => PermissionWaiter | undefined;
  },
): Promise<"allow" | "deny"> {
  if (opts.onPermission !== undefined) {
    return opts.onPermission(req);
  }
  return new Promise<"allow" | "deny">((resolve) => {
    opts.setWaiter({ req, resolve, previewOffset: 0 });
    opts.push(
      "status",
      formatPermissionBlock(req, undefined, opts.transcriptFormat),
    );
    void buildPermissionPreview(req, opts.cwd).then((preview) => {
      const waiter = opts.getWaiter();
      if (waiter === undefined || waiter.req !== req) return;
      if (preview !== undefined && preview.trim().length > 0) {
        waiter.preview = preview;
        opts.push(
          "status",
          formatPermissionBlock(req, preview, {
            ...opts.transcriptFormat,
            previewOffset: waiter.previewOffset,
          }),
        );
      }
    });
  });
}

/** U6a.4 — scroll the permission diff preview window. */
export function scrollPermissionPreviewImpl(
  delta: number,
  opts: {
    getWaiter: () => PermissionWaiter | undefined;
    push: PushFn;
    transcriptFormat: TranscriptFormatOptions;
  },
): boolean {
  const waiter = opts.getWaiter();
  if (waiter === undefined || waiter.preview === undefined) return false;
  const next = clampPermissionPreviewOffset(
    waiter.preview,
    waiter.previewOffset + delta,
  );
  if (next === waiter.previewOffset) return false;
  waiter.previewOffset = next;
  opts.push(
    "status",
    formatPermissionBlock(waiter.req, waiter.preview, {
      ...opts.transcriptFormat,
      previewOffset: next,
    }),
  );
  return true;
}

export function answerPermissionImpl(
  decision: "allow" | "deny",
  opts: {
    getWaiter: () => PermissionWaiter | undefined;
    setWaiter: (w: PermissionWaiter | undefined) => void;
    push: PushFn;
  },
): boolean {
  const waiter = opts.getWaiter();
  if (waiter === undefined) return false;
  waiter.resolve(decision);
  opts.setWaiter(undefined);
  opts.push("status", `permission → ${decision}`);
  return true;
}

export function handleUserQuestionRequestImpl(
  req: UserQuestionRequest,
  opts: {
    onUserQuestion?:
      | ((req: UserQuestionRequest) => Promise<UserQuestionAnswer>)
      | undefined;
    push: PushFn;
    setWaiter: (w: UserQuestionWaiter | undefined) => void;
  },
): Promise<UserQuestionAnswer> {
  if (opts.onUserQuestion !== undefined) {
    return opts.onUserQuestion(req);
  }
  return new Promise<UserQuestionAnswer>((resolve) => {
    opts.setWaiter({ req, resolve });
    const optionLine =
      req.options !== undefined && req.options.length > 0
        ? `\n  options: ${req.options
            .map((o, i) => {
              const mark =
                req.recommendedIndex === i ? " (recommended)" : "";
              return `${i + 1}. ${o}${mark}`;
            })
            .join(" · ")}`
        : "";
    opts.push(
      "status",
      `question — ${req.prompt}${optionLine}\n  (type answer + Enter · Esc cancels)`,
    );
  });
}

export function answerUserQuestionImpl(
  answer: UserQuestionAnswer,
  opts: {
    getWaiter: () => UserQuestionWaiter | undefined;
    setWaiter: (w: UserQuestionWaiter | undefined) => void;
    push: PushFn;
  },
): boolean {
  const waiter = opts.getWaiter();
  if (waiter === undefined) return false;
  waiter.resolve(answer);
  opts.setWaiter(undefined);
  opts.push(
    "status",
    answer.cancelled === true
      ? "question → cancelled"
      : `question → ${answer.value.length > 80 ? `${answer.value.slice(0, 77)}…` : answer.value}`,
  );
  return true;
}
