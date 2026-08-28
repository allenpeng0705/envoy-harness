/**
 * Minimal action journal for `/undo` — one stack per agent session.
 */

import { promises as fs } from "node:fs";

export interface UndoEntry {
  /** Absolute path that was written or edited. */
  path: string;
  /** File content before the tool ran; `null` if the file did not exist. */
  previousContent: string | null;
}

export class ActionJournal {
  private readonly stack: UndoEntry[] = [];

  push(entry: UndoEntry): void {
    this.stack.push(entry);
  }

  canUndo(): boolean {
    return this.stack.length > 0;
  }

  pop(): UndoEntry | undefined {
    return this.stack.pop();
  }

  clear(): void {
    this.stack.length = 0;
  }

  /** Restore the last journaled file change. */
  async undoLast(): Promise<{ path: string; action: "restored" | "removed" }> {
    const entry = this.pop();
    if (entry === undefined) {
      throw new Error("nothing to undo");
    }
    if (entry.previousContent === null) {
      await fs.unlink(entry.path);
      return { path: entry.path, action: "removed" };
    }
    await fs.writeFile(entry.path, entry.previousContent, "utf8");
    return { path: entry.path, action: "restored" };
  }
}
