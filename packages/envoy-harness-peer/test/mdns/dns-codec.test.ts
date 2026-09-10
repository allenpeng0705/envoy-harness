/**
 * DNS/mDNS wire codec — hermetic unit tests.
 *
 * No sockets, no network: every packet is built in-process and decoded
 * by the same module, including malformed inputs the module must reject
 * rather than throw on.
 */

import { describe, expect, it } from "vitest";

import {
  DNS_TYPE,
  allRecords,
  decodeMessage,
  encodeName,
  encodeQuery,
  encodeResponse,
  encodeTxtValues,
  type EncodeRecordInput,
} from "../../src/mdns/dns-codec.js";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe("encodeName", () => {
  it("encodes labels with a root terminator", () => {
    expect([...encodeName("local")]).toEqual([5, 108, 111, 99, 97, 108, 0]);
  });

  it("encodes multi-label names", () => {
    const encoded = encodeName("_envoy-harness._tcp.local");
    expect(encoded[0]).toBe("_envoy-harness".length);
    expect(encoded[encoded.length - 1]).toBe(0);
  });

  it("rejects an over-long label instead of emitting a broken packet", () => {
    expect(() => encodeName("a".repeat(64))).toThrow(/invalid DNS label/);
  });
});

describe("encodeQuery / decodeMessage", () => {
  it("round-trips a PTR browse query", () => {
    const decoded = decodeMessage(
      encodeQuery("_envoy-harness._tcp.local", DNS_TYPE.PTR),
    );
    expect(decoded).toBeDefined();
    expect(decoded?.isResponse).toBe(false);
    expect(decoded?.questions).toHaveLength(1);
    expect(decoded?.questions[0]?.name).toBe("_envoy-harness._tcp.local");
    expect(decoded?.questions[0]?.type).toBe(DNS_TYPE.PTR);
    expect(decoded?.questions[0]?.unicastResponse).toBe(false);
  });

  it("surfaces the QU (unicast response) bit without corrupting class", () => {
    const packet = encodeQuery("_envoy-harness._tcp.local", DNS_TYPE.PTR);
    // The QU bit is the top bit of the 16-bit QCLASS, i.e. the first
    // of the question's two trailing bytes.
    packet[packet.length - 2] = (packet[packet.length - 2] ?? 0) | 0x80;
    const decoded = decodeMessage(packet);
    expect(decoded?.questions[0]?.unicastResponse).toBe(true);
    expect(decoded?.questions[0]?.class).toBe(1);
  });
});

describe("encodeResponse / decodeMessage", () => {
  const records: EncodeRecordInput[] = [
    {
      name: "_envoy-harness._tcp.local",
      type: DNS_TYPE.PTR,
      ttl: 120,
      data: { kind: "ptr", target: "peer-1._envoy-harness._tcp.local" },
    },
    {
      name: "peer-1._envoy-harness._tcp.local",
      type: DNS_TYPE.SRV,
      ttl: 120,
      data: { kind: "srv", priority: 0, weight: 0, port: 8123, target: "host.local" },
    },
    {
      name: "peer-1._envoy-harness._tcp.local",
      type: DNS_TYPE.TXT,
      ttl: 120,
      data: { kind: "txt", values: ["id=peer-1", "model=deepseek-chat", "caps=a,b"] },
    },
    {
      name: "host.local",
      type: DNS_TYPE.A,
      ttl: 120,
      data: { kind: "a", address: "192.168.1.50" },
    },
  ];

  it("round-trips every record type discovery uses", () => {
    const decoded = decodeMessage(encodeResponse({ answers: records }));
    expect(decoded?.isResponse).toBe(true);
    const decodedRecords = decoded === undefined ? [] : allRecords(decoded);
    expect(decodedRecords).toHaveLength(4);

    const srv = decodedRecords.find((r) => r.type === DNS_TYPE.SRV);
    expect(srv?.data).toEqual({
      kind: "srv",
      priority: 0,
      weight: 0,
      port: 8123,
      target: "host.local",
    });

    const txt = decodedRecords.find((r) => r.type === DNS_TYPE.TXT);
    expect(txt?.data).toEqual({
      kind: "txt",
      values: ["id=peer-1", "model=deepseek-chat", "caps=a,b"],
    });

    const a = decodedRecords.find((r) => r.type === DNS_TYPE.A);
    expect(a?.data).toEqual({ kind: "a", address: "192.168.1.50" });
  });

  it("sets the cache-flush bit on answers but masks it when decoding", () => {
    const flushed = encodeResponse({ answers: [records[3] as EncodeRecordInput] });
    // The class field sits just past the 12-byte header, the
    // (uncompressed) name, and the 2-byte type.
    const classOffset = 12 + encodeName("host.local").length + 2;
    expect((flushed[classOffset] ?? 0) & 0x80).toBe(0x80);
    const decoded = decodeMessage(flushed);
    expect(decoded?.answers[0]?.class).toBe(1);
  });

  it("emits a TTL of 0 for a goodbye packet", () => {
    const decoded = decodeMessage(
      encodeResponse({ answers: records.map((r) => ({ ...r, ttl: 0 })) }),
    );
    expect(decoded?.answers.every((r) => r.ttl === 0)).toBe(true);
  });

  it("encodes IPv6 AAAA records", () => {
    const decoded = decodeMessage(
      encodeResponse({
        answers: [
          {
            name: "host.local",
            type: DNS_TYPE.AAAA,
            ttl: 60,
            data: { kind: "aaaa", address: "fe80:0:0:0:0:0:0:1" },
          },
        ],
      }),
    );
    expect(decoded?.answers[0]?.data).toEqual({
      kind: "aaaa",
      address: "fe80:0:0:0:0:0:0:1",
    });
  });
});

describe("name compression", () => {
  it("decodes a pointer to an earlier name", () => {
    // Header: response, 1 answer, 1 additional.
    const header = [
      0, 0, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 1,
    ];
    const serviceName = encodeName("_envoy-harness._tcp.local");
    const instance = encodeName("peer-9._envoy-harness._tcp.local");

    // Answer: serviceName PTR instance   (rdata starts at rdataOffset)
    const answerHead = [...serviceName, 0, DNS_TYPE.PTR, 0, 1, 0, 0, 0, 120];
    // DNS compression pointers are absolute offsets from the start of
    // the packet, so add the 12-byte header and the 2-byte RDLENGTH.
    const rdataOffset = 12 + answerHead.length + 2;
    const answer = [
      ...answerHead,
      (instance.length >> 8) & 0xff,
      instance.length & 0xff,
      ...instance,
    ];

    // Additional: pointer to the instance inside the PTR rdata, SRV.
    const pointer = [0xc0 | (rdataOffset >> 8), rdataOffset & 0xff];
    const target = encodeName("host.local");
    // priority, weight, port 8123, then the (uncompressed) target name.
    const srvRdata = [0, 0, 0, 0, 0x1f, 0xbb, ...target];
    const additional = [
      ...pointer,
      0,
      DNS_TYPE.SRV,
      0,
      1,
      0, 0, 0, 120,
      (srvRdata.length >> 8) & 0xff,
      srvRdata.length & 0xff,
      ...srvRdata,
    ];

    const packet = bytes(...header, ...answer, ...additional);
    const decoded = decodeMessage(packet);
    expect(decoded).toBeDefined();
    const srv = decoded?.additionals[0];
    expect(srv?.name).toBe("peer-9._envoy-harness._tcp.local");
    expect(srv?.data).toEqual({
      kind: "srv",
      priority: 0,
      weight: 0,
      port: 8123,
      target: "host.local",
    });
  });

  it("refuses a self-referencing pointer loop instead of hanging", () => {
    // A pointer at offset 12 that points back to itself.
    const packet = bytes(
      0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0,
      0xc0, 12, 0, DNS_TYPE.PTR, 0, 1, 0, 0, 0, 1, 0, 0,
    );
    expect(decodeMessage(packet)).toBeUndefined();
  });
});

describe("malformed input never throws", () => {
  it.each([
    ["empty", bytes()],
    ["short header", bytes(0, 0, 0x84)],
    ["truncated question", bytes(0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 104)],
    [
      "rdlength past end",
      bytes(0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 12, 0, 1, 0, 0, 0, 1, 0, 99),
    ],
    ["reserved label type", bytes(0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x40, 0, 0, 12, 0, 1, 0, 0, 0, 1, 0, 0)],
  ])("returns undefined for %s", (_label, packet) => {
    expect(decodeMessage(packet)).toBeUndefined();
  });

  it("survives random noise", () => {
    for (let i = 0; i < 200; i++) {
      const packet = Uint8Array.from({ length: 40 }, () =>
        Math.floor(Math.random() * 256),
      );
      expect(() => decodeMessage(packet)).not.toThrow();
    }
  });
});

describe("encodeTxtValues", () => {
  it("splits values longer than 255 bytes", () => {
    const long = "x".repeat(300);
    const encoded = encodeTxtValues([long]);
    expect(encoded[0]).toBe(255);
    expect(encoded[256]).toBe(45);
  });
});
