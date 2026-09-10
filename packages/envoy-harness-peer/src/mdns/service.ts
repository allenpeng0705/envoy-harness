/**
 * The envoy-harness DNS-SD service definition (RFC 6763).
 *
 * A peer advertises:
 *
 * ```
 * _envoy-harness._tcp.local.  PTR  <peerId>._envoy-harness._tcp.local.
 * <peerId>._envoy-harness._tcp.local.  SRV  0 0 <port> <host>.local.
 * <peerId>._envoy-harness._tcp.local.  TXT  "id=…" "model=…" "caps=…"
 * <host>.local.  A  <ipv4>
 * ```
 *
 * The TXT record is what makes discovery useful rather than merely
 * *possible*: `model` and `caps` let `PeerRegistry.pickByModel` route a
 * sub-agent to a capable peer without a human writing `--peers`.
 */

import type { DnsMessage, DnsRData, DnsRecord } from "./dns-codec.js";
import { DNS_TYPE, allRecords } from "./dns-codec.js";

/** Service type browsed and advertised by envoy peers. */
export const ENVOY_PEER_SERVICE_TYPE = "_envoy-harness._tcp.local";

/** TXT key carrying the peer id (equals the DNS-SD instance name). */
export const TXT_KEY_ID = "id";
/** TXT key carrying the peer's default model. */
export const TXT_KEY_MODEL = "model";
/** TXT key carrying a comma-separated capability list. */
export const TXT_KEY_CAPABILITIES = "caps";
/** TXT key carrying the peer package version. */
export const TXT_KEY_VERSION = "v";

/** Advertised peer metadata. */
export interface MdnsServiceInfo {
  /** Stable peer id; also the DNS-SD instance label. */
  readonly peerId: string;
  /** TCP port the MAP-over-JSON-RPC peer listens on. */
  readonly port: number;
  /** IPv4 address peers should dial. */
  readonly address: string;
  /** Optional default model the peer serves. */
  readonly model?: string;
  /** Optional capability tags (matches `CapabilityManifest` skills). */
  readonly capabilities?: ReadonlyArray<string>;
  /** Optional advertised version string. */
  readonly version?: string;
}

/** A peer reconstructed from a DNS-SD response. */
export interface MdnsServiceRecord {
  readonly peerId: string;
  readonly host: string;
  readonly port: number;
  readonly ttlSeconds: number;
  readonly model?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly version?: string;
}

/** The DNS-SD instance name for a peer id. */
export function serviceInstanceName(peerId: string): string {
  return `${sanitizeInstanceLabel(peerId)}.${ENVOY_PEER_SERVICE_TYPE}`;
}

/**
 * DNS-SD instance labels must survive a round trip through DNS name
 * encoding, so collapse anything that is not a safe label character.
 */
function sanitizeInstanceLabel(peerId: string): string {
  const cleaned = peerId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 63) : "envoy-peer";
}

/** Build the TXT strings for a service record. */
export function encodeServiceTxt(info: MdnsServiceInfo): string[] {
  const values = [
    `${TXT_KEY_ID}=${info.peerId}`,
    `${TXT_KEY_MODEL}=${info.model ?? ""}`,
  ];
  if (info.capabilities !== undefined && info.capabilities.length > 0) {
    values.push(`${TXT_KEY_CAPABILITIES}=${info.capabilities.join(",")}`);
  }
  if (info.version !== undefined && info.version.length > 0) {
    values.push(`${TXT_KEY_VERSION}=${info.version}`);
  }
  return values;
}

/**
 * Parse TXT strings back into a key/value map (later keys win).
 *
 * RFC 6763 §6.4 allows a value longer than 255 bytes to be split across
 * consecutive character-strings; a continuation has no `=`, so it is
 * appended to the previous key's value.
 */
export function parseServiceTxt(
  values: ReadonlyArray<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const entry of values) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      if (lastKey !== undefined) out[lastKey] = `${out[lastKey] ?? ""}${entry}`;
      continue;
    }
    lastKey = entry.slice(0, eq);
    out[lastKey] = entry.slice(eq + 1);
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Address record for a hostname, if the response carried one. */
function addressFor(
  records: ReadonlyArray<DnsRecord>,
  target: string,
): string | undefined {
  const wanted = target.toLowerCase();
  for (const record of records) {
    if (record.name.toLowerCase() !== wanted) continue;
    if (record.type === DNS_TYPE.A && record.data.kind === "a") {
      return record.data.address;
    }
    if (record.type === DNS_TYPE.AAAA && record.data.kind === "aaaa") {
      return record.data.address;
    }
  }
  return undefined;
}

/**
 * Reconstruct peer records from a decoded DNS-SD response.
 *
 * Records may be spread across answer/authority/additional sections
 * (a well-behaved responder puts SRV/TXT/A in the additional section),
 * so every section is searched.
 *
 * `senderAddress` is used as the dialable address when the response
 * carries no A/AAAA record for the SRV target — common when a responder
 * answers from an interface it does not name.
 */
export function extractServiceRecords(
  records: ReadonlyArray<DnsRecord>,
  senderAddress?: string,
): MdnsServiceRecord[] {
  const byName = new Map<string, DnsRecord[]>();
  for (const record of records) {
    const key = record.name.toLowerCase();
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [record]);
    else list.push(record);
  }

  const out: MdnsServiceRecord[] = [];
  for (const [instanceName, instanceRecords] of byName) {
    if (!instanceName.endsWith(`.${ENVOY_PEER_SERVICE_TYPE}`)) continue;

    let port: number | undefined;
    let target: string | undefined;
    let ttl = 0;
    let txtValues: ReadonlyArray<string> = [];

    for (const record of instanceRecords) {
      if (record.type === DNS_TYPE.SRV && record.data.kind === "srv") {
        port = record.data.port;
        target = record.data.target;
        ttl = record.ttl;
      } else if (record.type === DNS_TYPE.TXT && record.data.kind === "txt") {
        txtValues = record.data.values;
      }
    }
    if (port === undefined || port <= 0) continue;

    const host =
      (target !== undefined ? addressFor(records, target) : undefined) ??
      senderAddress;
    if (host === undefined) continue;

    const txt = parseServiceTxt(txtValues);
    const label = instanceName.slice(
      0,
      instanceName.length - ENVOY_PEER_SERVICE_TYPE.length - 1,
    );
    const capabilities = asString(txt[TXT_KEY_CAPABILITIES])
      ?.split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    out.push({
      peerId: asString(txt[TXT_KEY_ID]) ?? label,
      host,
      port,
      ttlSeconds: ttl,
      ...(asString(txt[TXT_KEY_MODEL]) !== undefined
        ? { model: asString(txt[TXT_KEY_MODEL]) as string }
        : {}),
      ...(capabilities !== undefined && capabilities.length > 0
        ? { capabilities }
        : {}),
      ...(asString(txt[TXT_KEY_VERSION]) !== undefined
        ? { version: asString(txt[TXT_KEY_VERSION]) as string }
        : {}),
    });
  }
  return out;
}

/** Every DNS-SD instance name referenced by a PTR answer for our type. */
export function instanceNamesFromPtr(
  records: ReadonlyArray<DnsRecord>,
): string[] {
  const wanted = ENVOY_PEER_SERVICE_TYPE.toLowerCase();
  const out: string[] = [];
  for (const record of records) {
    if (record.type !== DNS_TYPE.PTR) continue;
    if (record.name.toLowerCase() !== wanted) continue;
    if (record.data.kind !== "ptr") continue;
    out.push(record.data.target);
  }
  return out;
}

/** Convenience wrapper: PTR + SRV + TXT + A across all sections. */
export function serviceRecordsFromMessage(
  message: DnsMessage,
  senderAddress?: string,
): MdnsServiceRecord[] {
  return extractServiceRecords(allRecords(message), senderAddress);
}

/** Type guard helper used by the responder to build SRV RDATA. */
export function srvRData(port: number, target: string): DnsRData {
  return { kind: "srv", priority: 0, weight: 0, port, target };
}
