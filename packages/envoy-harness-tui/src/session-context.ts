/**
 * Shared context types for extracted session helpers.
 */

import type {
  ClientClusterStatus,
  ClientDiscoveryEvent,
  EnvoyHarnessClient,
} from "@envoymesh/envoy-harness-client";
import type { TurnHints } from "@envoymesh/envoy-harness";

import type {
  TranscriptFormatOptions,
  TranscriptLine,
  TranscriptRole,
} from "./transcript.js";

export type PushFn = (role: TranscriptRole, text: string) => void;

/** Minimal sink for cluster / info / policy helpers. */
export interface SessionSink {
  push: PushFn;
  readonly client: EnvoyHarnessClient;
  sessionId: string | undefined;
  busy: boolean;
}

/** Cluster rail + discovery helpers. */
export interface SessionClusterCtx extends SessionSink {
  clusterSnapshot: ClientClusterStatus | undefined;
  discoveryEvents: ClientDiscoveryEvent[];
  lines: readonly TranscriptLine[];
  transcriptFormat: TranscriptFormatOptions;
}

/** Session lifecycle + transcript mutations. */
export interface SessionWorkspaceCtx extends SessionSink {
  cwd: string | undefined;
  initialAutoRun: "safe-only" | "always-confirm" | "off" | undefined;
  lines: TranscriptLine[];
  onTranscript: ((lines: readonly TranscriptLine[]) => void) | undefined;
  turnSeen: Set<string>;
  lastTurnCostUsd: number | undefined;
  gitDiffStaged: boolean;
  gitDiffStat: boolean;
}

/** Streaming / activity protocol state (mutated in place). */
export interface SessionProtocolState {
  sessionId: string | undefined;
  busy: boolean;
  lines: TranscriptLine[];
  onTranscript: ((lines: readonly TranscriptLine[]) => void) | undefined;
  turnSeen: Set<string>;
  turnToolActivityLines: number;
  turnActivityLineIndices: number[];
  streamingAssistantText: string;
  streamingAssistantLineIndex: number | undefined;
  lastTurnCostUsd: number | undefined;
  turnHints: TurnHints | undefined;
}

export type SessionBasicRefs = {
  client: EnvoyHarnessClient;
  push: PushFn;
  getSessionId(): string | undefined;
  getBusy(): boolean;
};

export function buildSink(refs: SessionBasicRefs): SessionSink {
  return {
    push: refs.push,
    client: refs.client,
    get sessionId() {
      return refs.getSessionId();
    },
    get busy() {
      return refs.getBusy();
    },
  };
}

export type SessionClusterRefs = SessionBasicRefs & {
  getClusterSnapshot(): ClientClusterStatus | undefined;
  setClusterSnapshot(v: ClientClusterStatus | undefined): void;
  discoveryEvents: ClientDiscoveryEvent[];
  lines: readonly TranscriptLine[];
  transcriptFormat: TranscriptFormatOptions;
};

export function buildClusterCtx(refs: SessionClusterRefs): SessionClusterCtx {
  return {
    ...buildSink(refs),
    get clusterSnapshot() {
      return refs.getClusterSnapshot();
    },
    set clusterSnapshot(v) {
      refs.setClusterSnapshot(v);
    },
    discoveryEvents: refs.discoveryEvents,
    lines: refs.lines,
    transcriptFormat: refs.transcriptFormat,
  };
}

export type SessionWorkspaceRefs = SessionBasicRefs & {
  getSessionId(): string | undefined;
  setSessionId(v: string | undefined): void;
  cwd: string | undefined;
  initialAutoRun: "safe-only" | "always-confirm" | "off" | undefined;
  lines: TranscriptLine[];
  onTranscript: ((lines: readonly TranscriptLine[]) => void) | undefined;
  turnSeen: Set<string>;
  getLastTurnCostUsd(): number | undefined;
  setLastTurnCostUsd(v: number | undefined): void;
  getGitDiffStaged(): boolean;
  setGitDiffStaged(v: boolean): void;
  getGitDiffStat(): boolean;
  setGitDiffStat(v: boolean): void;
};

export function buildWorkspaceCtx(
  refs: SessionWorkspaceRefs,
): SessionWorkspaceCtx {
  return {
    ...buildSink(refs),
    get sessionId() {
      return refs.getSessionId();
    },
    set sessionId(v) {
      refs.setSessionId(v);
    },
    cwd: refs.cwd,
    initialAutoRun: refs.initialAutoRun,
    lines: refs.lines,
    onTranscript: refs.onTranscript,
    turnSeen: refs.turnSeen,
    get lastTurnCostUsd() {
      return refs.getLastTurnCostUsd();
    },
    set lastTurnCostUsd(v) {
      refs.setLastTurnCostUsd(v);
    },
    get gitDiffStaged() {
      return refs.getGitDiffStaged();
    },
    set gitDiffStaged(v) {
      refs.setGitDiffStaged(v);
    },
    get gitDiffStat() {
      return refs.getGitDiffStat();
    },
    set gitDiffStat(v) {
      refs.setGitDiffStat(v);
    },
  };
}

export type SessionProtocolRefs = {
  getSessionId(): string | undefined;
  getBusy(): boolean;
  lines: TranscriptLine[];
  onTranscript: ((lines: readonly TranscriptLine[]) => void) | undefined;
  turnSeen: Set<string>;
  turnActivityLineIndices: number[];
  getTurnToolActivityLines(): number;
  setTurnToolActivityLines(v: number): void;
  getStreamingAssistantText(): string;
  setStreamingAssistantText(v: string): void;
  getStreamingAssistantLineIndex(): number | undefined;
  setStreamingAssistantLineIndex(v: number | undefined): void;
  getLastTurnCostUsd(): number | undefined;
  setLastTurnCostUsd(v: number | undefined): void;
  getTurnHints(): TurnHints | undefined;
  setTurnHints(v: TurnHints | undefined): void;
};

export function buildProtocolState(
  refs: SessionProtocolRefs,
): SessionProtocolState {
  return {
    get sessionId() {
      return refs.getSessionId();
    },
    get busy() {
      return refs.getBusy();
    },
    lines: refs.lines,
    onTranscript: refs.onTranscript,
    turnSeen: refs.turnSeen,
    turnActivityLineIndices: refs.turnActivityLineIndices,
    get turnToolActivityLines() {
      return refs.getTurnToolActivityLines();
    },
    set turnToolActivityLines(v) {
      refs.setTurnToolActivityLines(v);
    },
    get streamingAssistantText() {
      return refs.getStreamingAssistantText();
    },
    set streamingAssistantText(v) {
      refs.setStreamingAssistantText(v);
    },
    get streamingAssistantLineIndex() {
      return refs.getStreamingAssistantLineIndex();
    },
    set streamingAssistantLineIndex(v) {
      refs.setStreamingAssistantLineIndex(v);
    },
    get lastTurnCostUsd() {
      return refs.getLastTurnCostUsd();
    },
    set lastTurnCostUsd(v) {
      refs.setLastTurnCostUsd(v);
    },
    get turnHints() {
      return refs.getTurnHints();
    },
    set turnHints(v) {
      refs.setTurnHints(v);
    },
  };
}
