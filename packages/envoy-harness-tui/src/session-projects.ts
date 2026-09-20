/**
 * `/project` — workspace (project) registry slash handlers.
 *
 * The registry lives on the host; these handlers only translate slash
 * arguments into client calls and surface errors as status lines.
 */

import type {
  ClientWorkspaceEntry,
  EnvoyHarnessClient,
} from "@envoymesh/envoy-harness-client";

import type { SessionWorkspaceCtx } from "./session-context.js";
import {
  clearActiveProject,
  createSessionImpl,
  setActiveProject,
} from "./session-workspace.js";
import { renderProjectsView } from "./views.js";

/**
 * Order returned by the most recent `/project list` per client, so
 * `/project open <index>` resolves against what the user actually saw.
 * Keyed by client (an object) to avoid leaking a process-wide cache.
 */
const lastListed = new WeakMap<EnvoyHarnessClient, ClientWorkspaceEntry[]>();

/** `/project list|add|remove|open` — one entry point for the dispatch. */
export async function runProjectImpl(
  s: SessionWorkspaceCtx,
  action: "list" | "add" | "remove" | "open",
  target?: string,
  name?: string,
): Promise<void> {
  try {
    switch (action) {
      case "list": {
        const entries = await s.client.listWorkspaces();
        lastListed.set(s.client, entries);
        s.push("status", renderProjectsView(entries).join("\n"));
        return;
      }
      case "add": {
        if (target === undefined) {
          s.push("status", "usage: /project add <absolute-path> [name]");
          return;
        }
        const entry = await s.client.addWorkspace(target, name);
        lastListed.delete(s.client);
        s.push("status", `added project ${entry.name} → ${entry.path}`);
        return;
      }
      case "remove": {
        if (target === undefined) {
          s.push("status", "usage: /project remove <path>");
          return;
        }
        const removed = await s.client.removeWorkspace(target);
        lastListed.delete(s.client);
        // Removing the project that `/new` would have used must not leave a
        // stale active project behind.
        if (removed) clearActiveProject(s.client);
        s.push(
          "status",
          removed
            ? `removed project ${target}`
            : `not in the project registry: ${target}`,
        );
        return;
      }
      case "open":
        await openProjectImpl(s, target);
        return;
    }
  } catch (err) {
    s.push("status", `project ${action} failed: ${(err as Error).message}`);
  }
}

async function openProjectImpl(
  s: SessionWorkspaceCtx,
  target: string | undefined,
): Promise<void> {
  if (target === undefined) {
    s.push("status", "usage: /project open <index|path>");
    return;
  }
  let entries = lastListed.get(s.client);
  if (entries === undefined) {
    entries = await s.client.listWorkspaces();
    lastListed.set(s.client, entries);
  }
  let entry: ClientWorkspaceEntry | undefined;
  if (/^\d+$/.test(target)) {
    const candidate = entries[Number(target) - 1];
    if (candidate === undefined) {
      s.push(
        "status",
        `project open: index ${target} out of range (1-${entries.length})`,
      );
      return;
    }
    entry = candidate;
  } else {
    entry = entries.find((e) => e.path === target);
    if (entry === undefined) {
      s.push(
        "status",
        `project open: no registered project with path ${target}`,
      );
      return;
    }
  }
  setActiveProject(s.client, entry.path);
  await createSessionImpl(s, entry.path, `new session (project ${entry.name})`);
}
