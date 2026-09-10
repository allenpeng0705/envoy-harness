/**
 * Real mDNS / DNS-SD browsing for envoy peers (replaces the old
 * placeholder that only worked with an injected browser).
 *
 * Behaviour:
 * - Binds a `reuseAddr` UDP socket on 5353 and joins 224.0.0.251.
 * - Sends a PTR query for {@link ENVOY_PEER_SERVICE_TYPE} immediately,
 *   then on an interval (default 5 s — cheap, and keeps TTLs fresh).
 * - Converts complete SRV+TXT(+A) answers into {@link MdnsServiceRecord}s
 *   and announces them through the {@link DiscoveryListener} contract.
 * - Expires records once their TTL lapses (or immediately on a TTL=0
 *   "goodbye" packet) and announces `lost`.
 *
 * **Fail-open contract:** socket/bind errors are reported through
 * `onError` and stop the browser; they are never thrown at the caller.
 * Discovery is an optional convenience — a laptop with multicast
 * disabled must still run `envoy-harness`.
 *
 * **Hermetic testing:** inject `socketFactory` and `scheduler`; the fake
 * socket feeds byte fixtures and the scheduler drives TTL expiry. No
 * network, no multicast, no wall-clock flakiness.
 */

import {
  MDNS_ADDRESS,
  MDNS_PORT,
  decodeMessage,
  encodeQuery,
  DNS_TYPE,
} from "./dns-codec.js";
import {
  ENVOY_PEER_SERVICE_TYPE,
  serviceRecordsFromMessage,
  type MdnsServiceRecord,
} from "./service.js";
import {
  createDgramMdnsSocket,
  type MdnsSenderInfo,
  type MdnsSocket,
  type MdnsSocketFactory,
} from "./socket.js";

/** Announcement shape consumed by the discovery rail. */
export interface MdnsPeerAnnouncement {
  readonly kind: "found" | "lost";
  readonly record: MdnsServiceRecord;
}

export type MdnsPeerListener = (event: MdnsPeerAnnouncement) => void;

/** Clock + timer seam so tests are deterministic. */
export interface MdnsScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export const defaultMdnsScheduler: MdnsScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  now: () => Date.now(),
};

export interface MdnsBrowserOptions {
  /** Socket factory; defaults to a real `dgram` socket. */
  socketFactory?: MdnsSocketFactory;
  /** Service type to browse. Default {@link ENVOY_PEER_SERVICE_TYPE}. */
  serviceType?: string;
  /** Re-query interval. Default 5000 ms. */
  queryIntervalMs?: number;
  /** TTL sweep interval. Default 1000 ms. */
  sweepIntervalMs?: number;
  /** TTL used when a responder omits one. Default 120 s. */
  defaultTtlSeconds?: number;
  /** Clock/timer injection for tests. */
  scheduler?: MdnsScheduler;
  /** Reported once per fatal socket problem; browsing then stops. */
  onError?: (err: Error) => void;
  /**
   * Bind port. Default {@link MDNS_PORT} (5353) — see
   * `createDgramMdnsSocket` for why this must be the mDNS port.
   */
  bindPort?: number;
}

interface KnownPeer {
  record: MdnsServiceRecord;
  expiresAt: number;
}

/**
 * Browse the LAN for envoy peers.
 *
 * `start()` resolves once the socket is bound (or immediately after a
 * reported error, so callers never see a rejection).
 */
export class MdnsBrowser {
  readonly #options: MdnsBrowserOptions;
  readonly #socketFactory: MdnsSocketFactory;
  readonly #scheduler: MdnsScheduler;
  readonly #known = new Map<string, KnownPeer>();

  #socket: MdnsSocket | undefined;
  #listener: MdnsPeerListener | undefined;
  #queryTimer: unknown;
  #sweepTimer: unknown;
  #running = false;
  #started = false;

  constructor(options: MdnsBrowserOptions = {}) {
    this.#options = options;
    this.#socketFactory = options.socketFactory ?? createDgramMdnsSocket;
    this.#scheduler = options.scheduler ?? defaultMdnsScheduler;
  }

  /** Whether the socket is bound and queries are being sent. */
  get running(): boolean {
    return this.#running;
  }

  /** Currently known peers (test + `/cluster` diagnostics seam). */
  knownPeers(): ReadonlyArray<MdnsServiceRecord> {
    return [...this.#known.values()].map((k) => k.record);
  }

  private get serviceType(): string {
    return this.#options.serviceType ?? ENVOY_PEER_SERVICE_TYPE;
  }

  private get defaultTtlSeconds(): number {
    return this.#options.defaultTtlSeconds ?? 120;
  }

  start(listener: MdnsPeerListener): Promise<void> {
    if (this.#running) return Promise.resolve();
    this.#listener = listener;
    const socket = this.#socketFactory();
    this.#socket = socket;

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (this.#started) return;
        this.#started = true;
        resolve();
      };
      socket.onError((err) => {
        this.#fail(err);
        finish();
      });
      socket.onMessage((packet, sender) => {
        this.#handlePacket(packet, sender);
      });
      try {
        socket.bind(this.#options.bindPort ?? MDNS_PORT, () => {
          try {
            socket.addMembership(MDNS_ADDRESS);
          } catch (err) {
            // Some CI/sandbox environments have no multicast route. The
            // browser is useless without the group, so report and stop —
            // but do not reject.
            this.#fail(err instanceof Error ? err : new Error(String(err)));
            finish();
            return;
          }
          this.#running = true;
          this.sendQuery();
          this.#queryTimer = this.#scheduler.setInterval(
            () => this.sendQuery(),
            this.#options.queryIntervalMs ?? 5_000,
          );
          this.#sweepTimer = this.#scheduler.setInterval(
            () => this.sweep(),
            this.#options.sweepIntervalMs ?? 1_000,
          );
          finish();
        });
      } catch (err) {
        this.#fail(err instanceof Error ? err : new Error(String(err)));
        finish();
      }
    });
  }

  stop(): void {
    this.#running = false;
    if (this.#queryTimer !== undefined) {
      this.#scheduler.clearInterval(this.#queryTimer);
      this.#queryTimer = undefined;
    }
    if (this.#sweepTimer !== undefined) {
      this.#scheduler.clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    this.#socket?.close();
    this.#socket = undefined;
    this.#listener = undefined;
    this.#known.clear();
  }

  /** Send one PTR browse query. Public for tests and manual re-query. */
  sendQuery(): void {
    if (this.#socket === undefined || !this.#running) return;
    const packet = encodeQuery(this.serviceType, DNS_TYPE.PTR);
    this.#socket.send(packet, MDNS_PORT, MDNS_ADDRESS);
  }

  /** Expire TTL-lapsed records. Public so tests can drive time. */
  sweep(): void {
    const now = this.#scheduler.now();
    for (const [peerId, entry] of [...this.#known]) {
      if (entry.expiresAt > now) continue;
      this.#known.delete(peerId);
      this.#listener?.({ kind: "lost", record: entry.record });
    }
  }

  #fail(err: Error): void {
    this.#running = false;
    this.#socket?.close();
    this.#socket = undefined;
    this.#options.onError?.(err);
  }

  /** Ingest one datagram. Public so tests can replay byte fixtures. */
  ingest(packet: Uint8Array, sender: MdnsSenderInfo): void {
    this.#handlePacket(packet, sender);
  }

  #handlePacket(packet: Uint8Array, sender: MdnsSenderInfo): void {
    const message = decodeMessage(packet);
    if (message === undefined || !message.isResponse) return;

    const records = serviceRecordsFromMessage(message, sender.address);
    const now = this.#scheduler.now();

    for (const record of records) {
      const expiresAt =
        now +
        (record.ttlSeconds > 0 ? record.ttlSeconds : this.defaultTtlSeconds) *
          1000;

      // RFC 6762 §10.1: a TTL of 0 is a "goodbye" — the peer is leaving.
      if (record.ttlSeconds === 0) {
        const existing = this.#known.get(record.peerId);
        if (existing !== undefined) {
          this.#known.delete(record.peerId);
          this.#listener?.({ kind: "lost", record: existing.record });
        }
        continue;
      }

      this.#known.set(record.peerId, { record, expiresAt });
      this.#listener?.({ kind: "found", record });
    }
  }
}
