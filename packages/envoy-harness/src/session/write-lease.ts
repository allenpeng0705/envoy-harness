/**
 * R4.3 — cross-process write ownership for session JSONL files.
 *
 * Sidecar lock (`<file>.lock`) via exclusive create (`wx`). Zero native
 * deps; sufficient for ACP host / EnvoyGo / second CLI contention.
 * Contended open fails with {@link SessionFileBusyError}.
 */

import { promises as fs } from "node:fs";

export class SessionFileBusyError extends Error {
  readonly code = "SESSION_FILE_BUSY" as const;
  readonly filePath: string;

  constructor(filePath: string, detail?: string) {
    super(
      detail ??
        `session file is locked by another process: ${filePath}`,
    );
    this.name = "SessionFileBusyError";
    this.filePath = filePath;
  }
}

export interface SessionWriteLease {
  readonly filePath: string;
  readonly lockPath: string;
  release(): Promise<void>;
}

export interface WriteLeaseProvider {
  acquire(filePath: string): Promise<SessionWriteLease>;
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryRemoveStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
    if (!(await pidAlive(pid))) {
      await fs.unlink(lockPath);
      return true;
    }
  } catch {
    // Missing or unreadable — treat as removable.
    try {
      await fs.unlink(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Default exclusive sidecar-lock provider. */
export const defaultWriteLeaseProvider: WriteLeaseProvider = {
  async acquire(filePath: string): Promise<SessionWriteLease> {
    const existing = sameProcessHolds.get(filePath);
    if (existing !== undefined) {
      existing.refs += 1;
      return wrapShared(filePath, existing);
    }

    const lockPath = lockPathFor(filePath);
    const payload = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    });

    const tryCreate = async (): Promise<fs.FileHandle> => {
      return fs.open(lockPath, "wx");
    };

    let handle: fs.FileHandle;
    try {
      handle = await tryCreate();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      const removed = await tryRemoveStaleLock(lockPath);
      if (!removed) {
        throw new SessionFileBusyError(filePath);
      }
      try {
        handle = await tryCreate();
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === "EEXIST") {
          throw new SessionFileBusyError(filePath);
        }
        throw err2;
      }
    }

    await handle.writeFile(payload, "utf-8");

    const entry: SameProcessHold = {
      refs: 1,
      async releaseBase() {
        try {
          await handle.close();
        } catch {
          // ignore
        }
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignore
        }
      },
    };
    sameProcessHolds.set(filePath, entry);
    return wrapShared(filePath, entry);
  },
};

interface SameProcessHold {
  refs: number;
  releaseBase(): Promise<void>;
}

const sameProcessHolds = new Map<string, SameProcessHold>();

function wrapShared(
  filePath: string,
  entry: SameProcessHold,
): SessionWriteLease {
  const lockPath = lockPathFor(filePath);
  let released = false;
  return {
    filePath,
    lockPath,
    async release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        sameProcessHolds.delete(filePath);
        await entry.releaseBase();
      }
    },
  };
}

let activeProvider: WriteLeaseProvider = defaultWriteLeaseProvider;

/** Test hook — swap the lease provider. */
export function setWriteLeaseProvider(provider: WriteLeaseProvider): void {
  activeProvider = provider;
}

export function resetWriteLeaseProvider(): void {
  activeProvider = defaultWriteLeaseProvider;
}

export async function acquireSessionWriteLease(
  filePath: string,
): Promise<SessionWriteLease> {
  return activeProvider.acquire(filePath);
}
