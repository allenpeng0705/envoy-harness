/**
 * The injectable UDP socket seam for mDNS.
 *
 * A callback interface (rather than Node's `EventEmitter`) so tests can
 * supply a ~40-line fake and drive the whole discovery stack without a
 * network, a multicast-capable interface, or a TTL.
 */

import * as dgram from "node:dgram";

import { MDNS_ADDRESS, MDNS_PORT } from "./dns-codec.js";

export interface MdnsSenderInfo {
  /** Source address of the datagram. */
  readonly address: string;
  /** Source port of the datagram. */
  readonly port: number;
}

/** The subset of a UDP socket mDNS needs. */
export interface MdnsSocket {
  onMessage(cb: (packet: Uint8Array, sender: MdnsSenderInfo) => void): void;
  onError(cb: (err: Error) => void): void;
  bind(port: number, onBound: () => void): void;
  addMembership(group: string): void;
  send(packet: Uint8Array, port: number, address: string): void;
  close(): void;
}

export type MdnsSocketFactory = () => MdnsSocket;

/**
 * Default socket: a UDP4 socket with `reuseAddr`.
 *
 * **Binding to 5353 is deliberate and required.** Multicast datagrams
 * are delivered only to sockets bound to the destination port, so a
 * socket on an ephemeral port would never see mDNS traffic. `reuseAddr`
 * lets us share 5353 with the platform responder (macOS
 * `mDNSResponder`, Linux `avahi-daemon`), which is how every JS mDNS
 * library does it. If a platform refuses the bind, the caller reports
 * the error and discovery degrades to the other configured sources —
 * it must never take the CLI down.
 */
export function createDgramMdnsSocket(): MdnsSocket {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    onMessage(cb) {
      socket.on("message", (msg, rinfo) => {
        cb(new Uint8Array(msg), {
          address: rinfo.address,
          port: rinfo.port,
        });
      });
    },
    onError(cb) {
      socket.on("error", cb);
    },
    bind(port, onBound) {
      socket.bind(port, onBound);
    },
    addMembership(group) {
      socket.addMembership(group);
    },
    send(packet, port, address) {
      socket.send(Buffer.from(packet), port, address, () => {
        /* send errors are surfaced through onError */
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Convenience re-export so callers do not import the codec for this. */
export const MDNS_DEFAULT_PORT = MDNS_PORT;
export const MDNS_DEFAULT_ADDRESS = MDNS_ADDRESS;
