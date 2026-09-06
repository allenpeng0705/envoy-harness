/**
 * R8.1 — default local mesh submitter for standalone CLI / ACP.
 *
 * Package 1 keeps `Agent` opt-in for `meshSubmitter`; the CLI runners
 * inject this helper so `task` works out of the box without EnvoyMesh.
 */

import type { ModelAdapter } from "../../model.js";
import type { PermissionMode } from "../../types.js";
import type { Tracer } from "../../trace/index.js";
import type { MeshSubmitter } from "../../subagent/types.js";
import {
  LocalMeshSubmitter,
  defaultBuildSubagentFactory,
} from "../../subagent/index.js";

export interface BuildCliLocalMeshSubmitterOptions {
  model: ModelAdapter;
  cwd: string;
  permissionMode?: PermissionMode;
  parentTracer?: Tracer;
  parentSessionId?: string;
  workerPeerId?: string;
}

/**
 * Build a `LocalMeshSubmitter` whose sub-agents can also call `task`
 * (nested submitter via a late-bound proxy).
 */
export function buildCliLocalMeshSubmitter(
  options: BuildCliLocalMeshSubmitterOptions,
): LocalMeshSubmitter {
  const holder: { current?: LocalMeshSubmitter } = {};
  const nestedSubmitter: MeshSubmitter = {
    submit: (input, signal) => {
      const s = holder.current;
      if (s === undefined) {
        throw new Error("cli LocalMeshSubmitter not initialized");
      }
      return s.submit(input, signal);
    },
    listSubagents: () => holder.current?.listSubagents?.() ?? [],
  };

  const permissionMode = options.permissionMode ?? "workspace-write";
  const submitter = new LocalMeshSubmitter({
    buildSubagent: defaultBuildSubagentFactory({
      model: options.model,
      cwd: options.cwd,
      permissionMode,
      meshSubmitter: nestedSubmitter,
      ...(options.parentTracer !== undefined
        ? { parentTracer: options.parentTracer }
        : {}),
      ...(options.parentSessionId !== undefined
        ? { parentSessionId: options.parentSessionId }
        : {}),
    }),
    workerPeerId: options.workerPeerId ?? "local",
  });
  holder.current = submitter;
  return submitter;
}
