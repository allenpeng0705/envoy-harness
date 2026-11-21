/**
 * Wave 3 — Mailbox V2 (durable parent-side board keyed by child id).
 *
 * Codex ordering: mailbox delivery is claimed before steer when
 * building turn input. Messages persist via session events.
 */

export interface MailboxMessage {
  id: string;
  fromChildId: string;
  body: string;
  createdAt: string;
  claimed?: boolean;
}

export class AgentMailbox {
  private readonly byChild = new Map<string, MailboxMessage[]>();
  private seq = 0;

  deliver(fromChildId: string, body: string): MailboxMessage {
    const msg: MailboxMessage = {
      id: `mb_${++this.seq}`,
      fromChildId,
      body,
      createdAt: new Date().toISOString(),
    };
    const list = this.byChild.get(fromChildId) ?? [];
    list.push(msg);
    this.byChild.set(fromChildId, list);
    return msg;
  }

  /** Unclaimed messages across all children (mailbox before steer). */
  peekUnclaimed(): MailboxMessage[] {
    const out: MailboxMessage[] = [];
    for (const list of this.byChild.values()) {
      for (const m of list) {
        if (m.claimed !== true) out.push(m);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Claim and return unclaimed messages (destructive read). */
  claimAll(): MailboxMessage[] {
    const claimed = this.peekUnclaimed();
    for (const m of claimed) m.claimed = true;
    return claimed;
  }

  listForChild(childId: string): MailboxMessage[] {
    return [...(this.byChild.get(childId) ?? [])];
  }

  /** Snapshot for session persistence. */
  snapshot(): MailboxMessage[] {
    const out: MailboxMessage[] = [];
    for (const list of this.byChild.values()) out.push(...list);
    return out;
  }

  restore(messages: ReadonlyArray<MailboxMessage>): void {
    this.byChild.clear();
    for (const m of messages) {
      const list = this.byChild.get(m.fromChildId) ?? [];
      list.push({ ...m });
      this.byChild.set(m.fromChildId, list);
      const n = Number(/^mb_(\d+)$/.exec(m.id)?.[1] ?? 0);
      if (n > this.seq) this.seq = n;
    }
  }
}
