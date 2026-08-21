/**
 * Phase C / Item 9 — owner-fenced terminal session registry.
 *
 * Backends own PTY mechanics; this service owns ids,
 * publication, authorization, exclusive sends, and cleanup.
 * Owner is an opaque string (typically `session.id`).
 */

import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalSendOperation,
  TerminalSessionService,
  TerminalSessionSnapshot,
  TerminalSignal,
} from "./types.js";
import { TerminalError } from "./types.js";

interface SessionRecord {
  readonly id: string;
  readonly owner: string;
  readonly name: string | undefined;
  readonly type: string;
  readonly session: TerminalBackendSession;
  active: TerminalSendOperation | undefined;
  closing: Promise<void> | undefined;
}

/** Create an in-process {@link TerminalSessionService}. */
export function createTerminalSessionService(): TerminalSessionService {
  const backends = new Map<string, TerminalBackend>();
  const sessions = new Map<string, SessionRecord>();
  const reservedNames = new Map<string, Set<string>>();
  let nextId = 0;
  let disposing = false;

  function assertActive(): void {
    if (disposing) {
      throw new TerminalError(
        "PTY service is disposing",
        "SERVICE_DISPOSING",
      );
    }
  }

  function snapshot(record: SessionRecord): TerminalSessionSnapshot;
  function snapshot(
    record: SessionRecord,
    motd: string,
  ): TerminalSessionSnapshot & { motd: string };
  function snapshot(
    record: SessionRecord,
    motd?: string,
  ): TerminalSessionSnapshot | (TerminalSessionSnapshot & { motd: string }) {
    const base: TerminalSessionSnapshot = {
      sessionId: record.id,
      type: record.type,
      status: record.session.status(),
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.session.pid !== undefined
        ? { pid: record.session.pid }
        : {}),
    };
    if (motd !== undefined) return { ...base, motd };
    return base;
  }

  function expectOwned(owner: string, sessionId: string): SessionRecord {
    const record = sessions.get(sessionId);
    if (record === undefined) {
      throw new TerminalError(
        `unknown PTY session ${sessionId}`,
        "NO_SESSION",
      );
    }
    if (record.owner !== owner) {
      throw new TerminalError(
        `PTY session ${sessionId} belongs to another owner`,
        "FOREIGN_SESSION",
      );
    }
    return record;
  }

  function reserveName(owner: string, name: string | undefined): () => void {
    if (name === undefined) return () => {};
    if (name.length === 0) {
      throw new Error("PTY session name must be non-empty");
    }
    for (const record of sessions.values()) {
      if (record.owner === owner && record.name === name) {
        throw new TerminalError(
          `PTY session name "${name}" already exists for this owner`,
          "DUPLICATE_NAME",
        );
      }
    }
    const reserved = reservedNames.get(owner) ?? new Set<string>();
    if (reserved.has(name)) {
      throw new TerminalError(
        `PTY session name "${name}" is already being created`,
        "DUPLICATE_NAME",
      );
    }
    reserved.add(name);
    reservedNames.set(owner, reserved);
    return () => {
      reserved.delete(name);
      if (reserved.size === 0) reservedNames.delete(owner);
    };
  }

  async function closeRecords(
    records: SessionRecord[],
    reason: string,
  ): Promise<void> {
    const results = await Promise.allSettled(
      records.map(async (record) => {
        const closing = record.closing ?? record.session.close(reason);
        record.closing = closing;
        try {
          await closing;
          sessions.delete(record.id);
        } catch (error: unknown) {
          if (record.closing === closing) record.closing = undefined;
          throw error;
        }
      }),
    );
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `failed to close ${failures.length} PTY session(s)`,
      );
    }
  }

  return {
    registerBackend(backend) {
      assertActive();
      if (backend.type.length === 0) {
        throw new Error("pty backend type must be non-empty");
      }
      if (backends.has(backend.type)) {
        throw new TerminalError(
          `a PTY backend named "${backend.type}" is already registered`,
          "DUPLICATE_BACKEND",
        );
      }
      backends.set(backend.type, backend);
      return () => {
        if (backends.get(backend.type) === backend) {
          backends.delete(backend.type);
        }
      };
    },

    listBackends() {
      return [...backends.keys()];
    },

    async spawn(owner, request, signal) {
      assertActive();
      signal?.throwIfAborted();
      const backend = backends.get(request.type);
      if (backend === undefined) {
        throw new TerminalError(
          `no PTY backend registered for "${request.type}"`,
          "NO_BACKEND",
        );
      }
      const releaseName = reserveName(owner, request.name);
      const sessionId = `pty-${++nextId}`;
      let session: TerminalBackendSession | undefined;
      try {
        const spawnSpec = {
          sessionId,
          owner,
          type: request.type,
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          ...(signal !== undefined ? { signal } : {}),
        };
        session = await backend.spawn(spawnSpec);
        signal?.throwIfAborted();
        if (disposing) {
          throw new TerminalError(
            "PTY service is disposing",
            "SERVICE_DISPOSING",
          );
        }
        const record: SessionRecord = {
          id: sessionId,
          owner,
          name: request.name,
          type: request.type,
          session,
          active: undefined,
          closing: undefined,
        };
        sessions.set(sessionId, record);
        return snapshot(record, session.motd);
      } catch (error) {
        if (session !== undefined && !sessions.has(sessionId)) {
          try {
            await session.close("PTY spawn rolled back");
          } catch (closeError: unknown) {
            throw new AggregateError(
              [error, closeError],
              "PTY spawn and rollback both failed",
            );
          }
        }
        throw error;
      } finally {
        releaseName();
      }
    },

    startSend(owner, sessionId, request) {
      const record = expectOwned(owner, sessionId);
      if (record.closing !== undefined) {
        throw new Error(`PTY session ${sessionId} is closing`);
      }
      if (record.active !== undefined) {
        throw new TerminalError(
          `PTY session ${sessionId} already has an active send`,
          "SEND_ACTIVE",
        );
      }
      const operation = record.session.startSend(request);
      record.active = operation;
      void operation.done.then(
        () => {
          if (record.active === operation) record.active = undefined;
        },
        () => {
          if (record.active === operation) record.active = undefined;
        },
      );
      return operation;
    },

    read(owner, sessionId, request: TerminalReadRequest = {}) {
      return expectOwned(owner, sessionId).session.read(request);
    },

    async signal(owner, sessionId, signal: TerminalSignal) {
      return expectOwned(owner, sessionId).session.signal(signal);
    },

    async kill(owner, sessionId, reason = "model request") {
      const record = expectOwned(owner, sessionId);
      if (record.closing !== undefined) {
        await record.closing;
        return false;
      }
      const closing = record.session.close(reason);
      record.closing = closing;
      try {
        await closing;
        sessions.delete(sessionId);
        return true;
      } catch (error) {
        record.closing = undefined;
        throw error;
      }
    },

    list(owner) {
      return [...sessions.values()]
        .filter((record) => record.owner === owner)
        .map((record) => snapshot(record));
    },

    async dispose() {
      if (disposing) return;
      disposing = true;
      try {
        await closeRecords(
          [...sessions.values()],
          "PTY service disposed",
        );
      } finally {
        backends.clear();
        reservedNames.clear();
        sessions.clear();
      }
    },
  };
}
