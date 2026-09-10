/**
 * mDNS / DNS-SD responder: makes an envoy peer discoverable on the LAN.
 *
 * Without this, browsing is useless — a browser alone can only find
 * peers that some *other* responder advertises. `envoy-peer serve
 * --advertise` uses this class so that a second machine running
 * `envoy-harness --discovery mdns` finds it with no `--peers` config.
 *
 * Behaviour (RFC 6762 §8, §10):
 * - Announces PTR + SRV + TXT + A once at start, repeated once after a
 *   short delay (the spec's "announce twice" rule against packet loss).
 * - Answers PTR / SRV / TXT / A queries for our own records.
 * - Answers multicast, or unicast to the asker when the query set the
 *   QU bit (RFC 6762 §5.4).
 * - Sends a goodbye (TTL=0) on `stop()` so peers drop us promptly.
 *
 * Like the browser, this is fail-open: bind/interface problems are
 * reported through `onError`, never thrown. A peer that cannot
 * advertise still serves TCP clients that were configured explicitly.
 */

import * as os from "node:os";

import {
  DNS_TYPE,
  MDNS_ADDRESS,
  MDNS_PORT,
  decodeMessage,
  encodeResponse,
  type EncodeRecordInput,
} from "./dns-codec.js";
import {
  ENVOY_PEER_SERVICE_TYPE,
  encodeServiceTxt,
  serviceInstanceName,
  type MdnsServiceInfo,
} from "./service.js";
import {
  createDgramMdnsSocket,
  type MdnsSenderInfo,
  type MdnsSocket,
  type MdnsSocketFactory,
} from "./socket.js";

export interface MdnsAdvertiserOptions {
  info: MdnsServiceInfo;
  socketFactory?: MdnsSocketFactory;
  bindPort?: number;
  onError?: (err: Error) => void;
  /** Re-announce delay for the second announcement. Default 1000 ms. */
  announceRepeatMs?: number;
  /** Timer seam for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The `.local` hostname this machine advertises (first label only). */
export function localHostName(hostname = os.hostname()): string {
  const first = hostname.split(".")[0] ?? "envoy-peer";
  const cleaned = first.replace(/[^A-Za-z0-9-]/g, "-");
  return `${cleaned.length > 0 ? cleaned : "envoy-peer"}.local`;
}

/**
 * Best-effort LAN IPv4 for this machine.
 *
 * Prefers a private address (the one peers can actually reach) over a
 * public or virtual one. Returns `undefined` when the machine has no
 * non-internal IPv4 interface, in which case the caller should skip
 * advertising rather than publish an unreachable record.
 */
export function resolveAdvertiseAddress(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string | undefined {
  const candidates: string[] = [];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      candidates.push(address.address);
    }
  }
  const isPrivate = (ip: string): boolean =>
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("169.254.");
  return candidates.find(isPrivate) ?? candidates[0];
}

export class MdnsAdvertiser {
  readonly #options: MdnsAdvertiserOptions;
  readonly #socketFactory: MdnsSocketFactory;
  #socket: MdnsSocket | undefined;
  #running = false;

  constructor(options: MdnsAdvertiserOptions) {
    this.#options = options;
    this.#socketFactory = options.socketFactory ?? createDgramMdnsSocket;
  }

  get running(): boolean {
    return this.#running;
  }

  private get hostName(): string {
    return localHostName();
  }

  /** The PTR + SRV + TXT + A record set describing this peer. */
  records(ttlSeconds = 120): EncodeRecordInput[] {
    const info = this.#options.info;
    const instance = serviceInstanceName(info.peerId);
    return [
      {
        name: ENVOY_PEER_SERVICE_TYPE,
        type: DNS_TYPE.PTR,
        ttl: ttlSeconds,
        data: { kind: "ptr", target: instance },
      },
      {
        name: instance,
        type: DNS_TYPE.SRV,
        ttl: ttlSeconds,
        data: {
          kind: "srv",
          priority: 0,
          weight: 0,
          port: info.port,
          target: this.hostName,
        },
      },
      {
        name: instance,
        type: DNS_TYPE.TXT,
        ttl: ttlSeconds,
        data: { kind: "txt", values: encodeServiceTxt(info) },
      },
      {
        name: this.hostName,
        type: DNS_TYPE.A,
        ttl: ttlSeconds,
        data: { kind: "a", address: info.address },
      },
    ];
  }

  start(): Promise<void> {
    if (this.#running) return Promise.resolve();
    const socket = this.#socketFactory();
    this.#socket = socket;

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.onError((err) => {
        this.#fail(err);
        finish();
      });
      socket.onMessage((packet, sender) => {
        this.#handleQuery(packet, sender);
      });
      try {
        socket.bind(this.#options.bindPort ?? MDNS_PORT, () => {
          try {
            socket.addMembership(MDNS_ADDRESS);
          } catch (err) {
            this.#fail(err instanceof Error ? err : new Error(String(err)));
            finish();
            return;
          }
          this.#running = true;
          this.announce();
          const repeat = this.#options.announceRepeatMs ?? 1_000;
          const setTimer =
            this.#options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
          setTimer(() => {
            if (this.#running) this.announce();
          }, repeat);
          finish();
        });
      } catch (err) {
        this.#fail(err instanceof Error ? err : new Error(String(err)));
        finish();
      }
    });
  }

  /** Multicast the full record set (unsolicited announcement). */
  announce(): void {
    if (this.#socket === undefined || !this.#running) return;
    this.#socket.send(
      encodeResponse({ answers: this.records() }),
      MDNS_PORT,
      MDNS_ADDRESS,
    );
  }

  /** Send the RFC 6762 §10.1 goodbye (all records at TTL 0). */
  sendGoodbye(): void {
    if (this.#socket === undefined) return;
    this.#socket.send(
      encodeResponse({ answers: this.records(0) }),
      MDNS_PORT,
      MDNS_ADDRESS,
    );
  }

  stop(): void {
    if (!this.#running) {
      this.#socket?.close();
      this.#socket = undefined;
      return;
    }
    this.sendGoodbye();
    this.#running = false;
    this.#socket?.close();
    this.#socket = undefined;
  }

  /** Answer one inbound query. Public so tests can replay fixtures. */
  handleQuery(packet: Uint8Array, sender: MdnsSenderInfo): void {
    this.#handleQuery(packet, sender);
  }

  #handleQuery(packet: Uint8Array, sender: MdnsSenderInfo): void {
    if (this.#socket === undefined) return;
    const message = decodeMessage(packet);
    if (message === undefined || message.isResponse) return;

    const all = this.records();
    const answers: EncodeRecordInput[] = [];
    const additionals: EncodeRecordInput[] = [];
    let wantsUnicast = false;

    for (const question of message.questions) {
      if (question.unicastResponse) wantsUnicast = true;
      const name = question.name.toLowerCase();
      for (const record of all) {
        if (record.name.toLowerCase() !== name) continue;
        if (record.type === question.type) answers.push(record);
      }
      // A PTR browse is the common case: answer it with the full set so
      // the asker does not need three more round trips.
      if (
        name === ENVOY_PEER_SERVICE_TYPE.toLowerCase() &&
        question.type === DNS_TYPE.PTR
      ) {
        for (const record of all) {
          if (record.type !== DNS_TYPE.PTR) additionals.push(record);
        }
      }
    }

    if (answers.length === 0) return;
    const response = encodeResponse({ answers, additionals });
    if (wantsUnicast) {
      this.#socket.send(response, sender.port, sender.address);
    } else {
      this.#socket.send(response, MDNS_PORT, MDNS_ADDRESS);
    }
  }

  #fail(err: Error): void {
    this.#running = false;
    this.#socket?.close();
    this.#socket = undefined;
    this.#options.onError?.(err);
  }
}
