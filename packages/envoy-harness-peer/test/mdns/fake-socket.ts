/**
 * Shared fake mDNS socket for hermetic tests.
 *
 * Records everything sent, and lets a test push a datagram in as if it
 * arrived from the LAN. No real socket, no multicast, no network.
 */

import type { MdnsSenderInfo, MdnsSocket } from "../../src/mdns/socket.js";

export interface SentPacket {
  packet: Uint8Array;
  port: number;
  address: string;
}

export interface FakeMdnsSocket extends MdnsSocket {
  readonly sent: SentPacket[];
  /** Push a datagram in (as if received). */
  deliver(packet: Uint8Array, sender?: MdnsSenderInfo): void;
  /** Make the next bind report an error (simulates EADDRINUSE). */
  failBind(err?: Error): void;
  /** Make `addMembership` throw (simulates "no multicast route"). */
  failMembership(err?: Error): void;
  readonly closed: boolean;
  readonly boundPort: number | undefined;
  readonly memberships: string[];
  /** Resolve `bind` automatically (default true). */
  autoBind: boolean;
}

export function createFakeMdnsSocket(): FakeMdnsSocket {
  let messageCb: ((p: Uint8Array, s: MdnsSenderInfo) => void) | undefined;
  let errorCb: ((e: Error) => void) | undefined;
  let bindError: Error | undefined;
  let membershipError: Error | undefined;
  const memberships: string[] = [];
  let boundPort: number | undefined;
  let closed = false;

  const socket: FakeMdnsSocket = {
    sent: [],
    autoBind: true,

    onMessage(cb) {
      messageCb = cb;
    },
    onError(cb) {
      errorCb = cb;
    },
    bind(port, onBound) {
      if (bindError !== undefined) {
        const err = bindError;
        bindError = undefined;
        // Report asynchronously, like a real socket.
        queueMicrotask(() => errorCb?.(err));
        return;
      }
      boundPort = port;
      if (socket.autoBind) queueMicrotask(onBound);
    },
    addMembership(group) {
      if (membershipError !== undefined) {
        const err = membershipError;
        membershipError = undefined;
        throw err;
      }
      memberships.push(group);
    },
    send(packet, port, address) {
      socket.sent.push({ packet, port, address });
    },
    close() {
      closed = true;
    },

    deliver(packet, sender) {
      messageCb?.(packet, sender ?? { address: "192.168.1.50", port: 5353 });
    },
    failBind(err) {
      bindError = err ?? Object.assign(new Error("bind EADDRINUSE"), { code: "EADDRINUSE" });
    },
    failMembership(err) {
      membershipError = err ?? new Error("addMembership ENODEV");
    },
    get closed() {
      return closed;
    },
    get boundPort() {
      return boundPort;
    },
    get memberships() {
      return memberships;
    },
  };

  return socket;
}

/** A deterministic clock + manual timer queue. */
export interface ManualScheduler {
  now(): number;
  advance(ms: number): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function createManualScheduler(start = 1_000_000): ManualScheduler & {
  tick(handle?: unknown): void;
} {
  let current = start;
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
  let nextId = 1;

  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms, next: current + ms });
      return id;
    },
    clearInterval(handle) {
      if (typeof handle === "number") intervals.delete(handle);
    },
    // Run every interval whose deadline has passed (drives query/sweep).
    tick() {
      for (const [, entry] of intervals) {
        if (entry.next <= current) {
          entry.next = current + entry.ms;
          entry.fn();
        }
      }
    },
  };
}
