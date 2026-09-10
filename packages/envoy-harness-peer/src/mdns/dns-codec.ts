/**
 * Minimal DNS wire codec for mDNS / DNS-SD (RFC 1035 + RFC 6762/6763).
 *
 * **Why hand-rolled instead of an npm dependency:** envoy-harness ships
 * with a deliberately tiny runtime dependency set (`zod`, `yaml`,
 * `smol-toml`), the peer package must stay installable on a laptop with
 * no mesh, and the interesting part — record parsing — is pure code we
 * can test hermetically against byte fixtures. A socket is the only
 * impure piece and it is injected.
 *
 * **Scope:** exactly what peer discovery needs — PTR (service browse),
 * SRV (host + port), TXT (metadata), A/AAAA (address), plus graceful
 * skipping of everything else. This is NOT a general DNS resolver:
 * there are no EDNS0 options, no DNSSEC, and unknown record types are
 * preserved as raw bytes rather than interpreted.
 *
 * **Robustness rule:** parsers NEVER throw on malformed input. The mDNS
 * socket receives traffic from every Bonjour/Avahi device on the LAN,
 * so a parse failure must be a skipped packet, not a crashed CLI. Use
 * {@link decodeMessage} returning `undefined` for "not parseable".
 */

/** DNS RR type codes we understand. */
export const DNS_TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
} as const;

/** DNS class IN (the only class mDNS uses). */
export const DNS_CLASS_IN = 1;

/** mDNS multicast group and port (RFC 6762 §3). */
export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;

/** Decoded RDATA for the record types peer discovery uses. */
export type DnsRData =
  | { readonly kind: "ptr"; readonly target: string }
  | {
      readonly kind: "srv";
      readonly priority: number;
      readonly weight: number;
      readonly port: number;
      readonly target: string;
    }
  | { readonly kind: "txt"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "a"; readonly address: string }
  | { readonly kind: "aaaa"; readonly address: string }
  | { readonly kind: "unknown"; readonly type: number; readonly raw: Uint8Array };

export interface DnsRecord {
  readonly name: string;
  readonly type: number;
  readonly class: number;
  readonly ttl: number;
  readonly data: DnsRData;
}

export interface DnsQuestion {
  readonly name: string;
  readonly type: number;
  readonly class: number;
  /**
   * RFC 6762 §5.4 "QU" bit: the asker wants a unicast reply to the
   * source address/port rather than a multicast one. `class` has the
   * bit masked off, so a responder needs this flag to answer correctly.
   */
  readonly unicastResponse: boolean;
}

export interface DnsMessage {
  readonly id: number;
  readonly isResponse: boolean;
  readonly questions: ReadonlyArray<DnsQuestion>;
  readonly answers: ReadonlyArray<DnsRecord>;
  readonly authorities: ReadonlyArray<DnsRecord>;
  readonly additionals: ReadonlyArray<DnsRecord>;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Encode a dotted name into length-prefixed labels (no compression). */
export function encodeName(name: string): Uint8Array {
  const labels = name
    .split(".")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const chunks: number[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    // A label is 1..63 bytes; anything longer is invalid DNS and would
    // corrupt the packet, so fail loudly at the builder rather than
    // emitting a malformed message.
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error(`invalid DNS label length ${bytes.length}: "${label}"`);
    }
    chunks.push(bytes.length);
    for (const b of bytes) chunks.push(b);
  }
  chunks.push(0); // root
  return Uint8Array.from(chunks);
}

/** Encode a TXT RDATA body: length-prefixed strings. */
export function encodeTxtValues(values: ReadonlyArray<string>): Uint8Array {
  const chunks: number[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    // A single character-string is capped at 255 bytes; longer values
    // are split across multiple strings, which is legal and which the
    // parser re-joins via the caller's key/value convention.
    for (let offset = 0; offset < bytes.length; offset += 255) {
      const slice = bytes.subarray(offset, offset + 255);
      chunks.push(slice.length);
      for (const b of slice) chunks.push(b);
    }
    if (bytes.length === 0) chunks.push(0);
  }
  return Uint8Array.from(chunks);
}

/** Build a standard query message for one question. */
export function encodeQuery(name: string, type: number): Uint8Array {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id: 0 for mDNS one-shot queries
  header.writeUInt16BE(0, 2); // flags: standard query, no recursion
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(0, 10); // arcount
  const qname = encodeName(name);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(DNS_CLASS_IN, 2);
  return Uint8Array.from(Buffer.concat([header, Buffer.from(qname), tail]));
}

/** One record to place in a response. */
export interface EncodeRecordInput {
  readonly name: string;
  readonly type: number;
  readonly ttl: number;
  readonly data: DnsRData;
}

function encodeRData(record: EncodeRecordInput): Uint8Array {
  switch (record.data.kind) {
    case "ptr":
      return encodeName(record.data.target);
    case "srv": {
      const head = Buffer.alloc(6);
      head.writeUInt16BE(record.data.priority, 0);
      head.writeUInt16BE(record.data.weight, 2);
      head.writeUInt16BE(record.data.port, 4);
      return Uint8Array.from(
        Buffer.concat([head, Buffer.from(encodeName(record.data.target))]),
      );
    }
    case "txt":
      return encodeTxtValues(record.data.values);
    case "a": {
      const parts = record.data.address.split(".").map((p) => Number(p));
      if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
        throw new Error(`invalid IPv4 address: ${record.data.address}`);
      }
      return Uint8Array.from(parts);
    }
    case "aaaa": {
      const groups = expandIpv6(record.data.address);
      return Uint8Array.from(groups);
    }
    case "unknown":
      return record.data.raw;
  }
}

function expandIpv6(address: string): number[] {
  const [head = "", tail = ""] = address.split("::");
  const left = head.length > 0 ? head.split(":") : [];
  const right = tail.length > 0 ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ];
  const out: number[] = [];
  for (const g of groups) {
    const n = Number.parseInt(g.length === 0 ? "0" : g, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
      throw new Error(`invalid IPv6 group: ${g}`);
    }
    out.push((n >> 8) & 0xff, n & 0xff);
  }
  return out;
}

function encodeRecord(record: EncodeRecordInput): Uint8Array {
  const name = encodeName(record.name);
  const rdata = encodeRData(record);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(record.type, 0);
  header.writeUInt16BE(DNS_CLASS_IN, 2);
  header.writeUInt32BE(record.ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Uint8Array.from(
    Buffer.concat([Buffer.from(name), header, Buffer.from(rdata)]),
  );
}

/**
 * Build an mDNS **response** message (announcement or query answer).
 * Names are written uncompressed — legal, slightly larger, and far
 * simpler to reason about. `cacheFlush` sets the top bit of the class
 * for records we own (RFC 6762 §10.2).
 */
export function encodeResponse(options: {
  readonly answers: ReadonlyArray<EncodeRecordInput>;
  readonly additionals?: ReadonlyArray<EncodeRecordInput>;
  readonly authorities?: ReadonlyArray<EncodeRecordInput>;
  /** Set the cache-flush bit on answer records. Default true. */
  readonly cacheFlush?: boolean;
}): Uint8Array {
  const answers = options.answers.map((r) =>
    recordBytesWithClass(r, options.cacheFlush !== false),
  );
  const additionals = (options.additionals ?? []).map((r) =>
    recordBytesWithClass(r, false),
  );
  const authorities = (options.authorities ?? []).map((r) =>
    recordBytesWithClass(r, false),
  );

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id 0
  header.writeUInt16BE(0x8400, 2); // QR=1, AA=1
  header.writeUInt16BE(0, 4); // qdcount
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Uint8Array.from(
    Buffer.concat([header, ...answers, ...authorities, ...additionals]),
  );
}

/** Encode a record but override the class field (for cache-flush). */
function recordBytesWithClass(
  record: EncodeRecordInput,
  cacheFlush: boolean,
): Uint8Array {
  const bytes = encodeRecord(record);
  const nameLen = encodeName(record.name).length;
  const classOffset = nameLen + 2; // skip NAME + TYPE
  if (cacheFlush) {
    const current = (bytes[classOffset] ?? 0) << 8 | (bytes[classOffset + 1] ?? 0);
    const next = current | 0x8000;
    bytes[classOffset] = (next >> 8) & 0xff;
    bytes[classOffset + 1] = next & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

class Reader {
  constructor(
    private readonly buf: Uint8Array,
    public offset = 0,
  ) {}

  get length(): number {
    return this.buf.length;
  }

  u8(): number | undefined {
    if (this.offset >= this.buf.length) return undefined;
    const v = this.buf[this.offset];
    this.offset += 1;
    return v;
  }

  u16(): number | undefined {
    if (this.offset + 2 > this.buf.length) return undefined;
    const v = ((this.buf[this.offset] ?? 0) << 8) | (this.buf[this.offset + 1] ?? 0);
    this.offset += 2;
    return v;
  }

  u32(): number | undefined {
    if (this.offset + 4 > this.buf.length) return undefined;
    const v =
      ((this.buf[this.offset] ?? 0) * 0x1000000) +
      (((this.buf[this.offset + 1] ?? 0) << 16) |
        ((this.buf[this.offset + 2] ?? 0) << 8) |
        (this.buf[this.offset + 3] ?? 0));
    this.offset += 4;
    return v >>> 0;
  }

  bytes(n: number): Uint8Array | undefined {
    if (this.offset + n > this.buf.length) return undefined;
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
}

/**
 * Read a (possibly compressed) domain name starting at `start`.
 * Returns the name and the offset just past the name **in the original
 * stream** (compression pointers do not advance the outer cursor).
 */
function readName(
  buf: Uint8Array,
  start: number,
): { name: string; end: number } | undefined {
  const labels: string[] = [];
  let offset = start;
  let end = -1;
  let jumps = 0;

  for (;;) {
    if (offset >= buf.length) return undefined;
    const len = buf[offset] ?? 0;
    if (len === 0) {
      offset += 1;
      if (end === -1) end = offset;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 2 > buf.length) return undefined;
      const pointer = ((len & 0x3f) << 8) | (buf[offset + 1] ?? 0);
      if (end === -1) end = offset + 2;
      // Guard against pointer loops from hostile/broken senders.
      jumps += 1;
      if (jumps > 32 || pointer >= buf.length) return undefined;
      offset = pointer;
      continue;
    }
    if ((len & 0xc0) !== 0) return undefined; // reserved label type
    offset += 1;
    if (offset + len > buf.length) return undefined;
    labels.push(Buffer.from(buf.subarray(offset, offset + len)).toString("utf8"));
    offset += len;
  }

  return { name: labels.join("."), end };
}

function decodeRData(
  buf: Uint8Array,
  type: number,
  rdStart: number,
  rdLength: number,
): DnsRData | undefined {
  const raw = buf.subarray(rdStart, rdStart + rdLength);
  switch (type) {
    case DNS_TYPE.PTR: {
      const pointed = readName(buf, rdStart);
      if (pointed === undefined) return undefined;
      return { kind: "ptr", target: pointed.name };
    }
    case DNS_TYPE.SRV: {
      if (rdLength < 6) return undefined;
      const priority = ((raw[0] ?? 0) << 8) | (raw[1] ?? 0);
      const weight = ((raw[2] ?? 0) << 8) | (raw[3] ?? 0);
      const port = ((raw[4] ?? 0) << 8) | (raw[5] ?? 0);
      const target = readName(buf, rdStart + 6);
      if (target === undefined) return undefined;
      return { kind: "srv", priority, weight, port, target: target.name };
    }
    case DNS_TYPE.TXT: {
      const values: string[] = [];
      let i = 0;
      while (i < raw.length) {
        const n = raw[i] ?? 0;
        i += 1;
        if (i + n > raw.length) break;
        values.push(Buffer.from(raw.subarray(i, i + n)).toString("utf8"));
        i += n;
      }
      return { kind: "txt", values };
    }
    case DNS_TYPE.A: {
      if (rdLength !== 4) return undefined;
      return {
        kind: "a",
        address: `${raw[0] ?? 0}.${raw[1] ?? 0}.${raw[2] ?? 0}.${raw[3] ?? 0}`,
      };
    }
    case DNS_TYPE.AAAA: {
      if (rdLength !== 16) return undefined;
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) {
        groups.push(
          (((raw[i] ?? 0) << 8) | (raw[i + 1] ?? 0)).toString(16),
        );
      }
      return { kind: "aaaa", address: groups.join(":") };
    }
    default:
      return { kind: "unknown", type, raw };
  }
}

function readRecords(
  reader: Reader,
  buf: Uint8Array,
  count: number,
): DnsRecord[] | undefined {
  const out: DnsRecord[] = [];
  for (let i = 0; i < count; i++) {
    const name = readName(buf, reader.offset);
    if (name === undefined) return undefined;
    reader.offset = name.end;
    const type = reader.u16();
    const cls = reader.u16();
    const ttl = reader.u32();
    const rdLength = reader.u16();
    if (
      type === undefined ||
      cls === undefined ||
      ttl === undefined ||
      rdLength === undefined
    ) {
      return undefined;
    }
    const rdStart = reader.offset;
    if (rdStart + rdLength > buf.length) return undefined;
    const data = decodeRData(buf, type, rdStart, rdLength);
    if (data === undefined) return undefined;
    reader.offset = rdStart + rdLength;
    out.push({
      name: name.name,
      type,
      // Mask off the mDNS cache-flush bit so callers see a plain class.
      class: cls & 0x7fff,
      ttl,
      data,
    });
  }
  return out;
}

/**
 * Parse a DNS/mDNS message. Returns `undefined` for anything malformed
 * — see the robustness rule at the top of this file.
 */
export function decodeMessage(packet: Uint8Array): DnsMessage | undefined {
  if (packet.length < 12) return undefined;
  const reader = new Reader(packet);
  const id = reader.u16();
  const flags = reader.u16();
  const qdCount = reader.u16();
  const anCount = reader.u16();
  const nsCount = reader.u16();
  const arCount = reader.u16();
  if (
    id === undefined ||
    flags === undefined ||
    qdCount === undefined ||
    anCount === undefined ||
    nsCount === undefined ||
    arCount === undefined
  ) {
    return undefined;
  }

  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdCount; i++) {
    const name = readName(packet, reader.offset);
    if (name === undefined) return undefined;
    reader.offset = name.end;
    const type = reader.u16();
    const cls = reader.u16();
    if (type === undefined || cls === undefined) return undefined;
    questions.push({
      name: name.name,
      type,
      class: cls & 0x7fff,
      unicastResponse: (cls & 0x8000) !== 0,
    });
  }

  const answers = readRecords(reader, packet, anCount);
  if (answers === undefined) return undefined;
  const authorities = readRecords(reader, packet, nsCount);
  if (authorities === undefined) return undefined;
  const additionals = readRecords(reader, packet, arCount);
  if (additionals === undefined) return undefined;

  return {
    id,
    isResponse: (flags & 0x8000) !== 0,
    questions,
    answers,
    authorities,
    additionals,
  };
}

/** Convenience: every record across all three sections. */
export function allRecords(message: DnsMessage): DnsRecord[] {
  return [...message.answers, ...message.authorities, ...message.additionals];
}
