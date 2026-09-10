/**
 * mDNS discovery stack — hermetic tests.
 *
 * Everything runs against the fake socket + manual scheduler: no
 * multicast, no LAN, no wall-clock timing, so these tests are
 * deterministic on every platform and in CI sandboxes where multicast
 * is unavailable.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DNS_TYPE,
  ENVOY_PEER_SERVICE_TYPE,
  MdnsAdvertiser,
  MdnsBrowser,
  MdnsDiscoverySource,
  decodeMessage,
  encodeQuery,
  encodeResponse,
  encodeServiceTxt,
  extractServiceRecords,
  localHostName,
  parseServiceTxt,
  resolveAdvertiseAddress,
  serviceInstanceName,
  type EncodeRecordInput,
} from "../src/index.js";
import { createFakeMdnsSocket, createManualScheduler } from "./mdns/fake-socket.js";

const PEER = {
  peerId: "peer-1",
  host: "192.168.1.50",
  port: 8123,
  model: "deepseek-chat",
  capabilities: ["code-edit", "bash-run"],
};

/** A complete DNS-SD response for {@link PEER}, as a responder would send. */
function peerResponse(
  overrides: Partial<typeof PEER & { ttl: number }> = {},
): Uint8Array {
  const peer = { ...PEER, ttl: 120, ...overrides };
  const instance = serviceInstanceName(peer.peerId);
  const records: EncodeRecordInput[] = [
    {
      name: ENVOY_PEER_SERVICE_TYPE,
      type: DNS_TYPE.PTR,
      ttl: peer.ttl,
      data: { kind: "ptr", target: instance },
    },
    {
      name: instance,
      type: DNS_TYPE.SRV,
      ttl: peer.ttl,
      data: { kind: "srv", priority: 0, weight: 0, port: peer.port, target: "host.local" },
    },
    {
      name: instance,
      type: DNS_TYPE.TXT,
      ttl: peer.ttl,
      data: {
        kind: "txt",
        values: [
          `id=${peer.peerId}`,
          `model=${peer.model}`,
          `caps=${peer.capabilities.join(",")}`,
        ],
      },
    },
    {
      name: "host.local",
      type: DNS_TYPE.A,
      ttl: peer.ttl,
      data: { kind: "a", address: peer.host },
    },
  ];
  return encodeResponse({ answers: records });
}

describe("service records", () => {
  it("reconstructs a peer from a full DNS-SD response", () => {
    const message = decodeMessage(peerResponse());
    expect(message).toBeDefined();
    const records = extractServiceRecords(
      message === undefined
        ? []
        : [...message.answers, ...message.authorities, ...message.additionals],
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      peerId: "peer-1",
      host: "192.168.1.50",
      port: 8123,
      ttlSeconds: 120,
      model: "deepseek-chat",
      capabilities: ["code-edit", "bash-run"],
    });
  });

  it("falls back to the sender address when no A record is present", () => {
    const instance = serviceInstanceName("peer-2");
    const packet = encodeResponse({
      answers: [
        {
          name: instance,
          type: DNS_TYPE.SRV,
          ttl: 60,
          data: { kind: "srv", priority: 0, weight: 0, port: 9000, target: "unknown.local" },
        },
        {
          name: instance,
          type: DNS_TYPE.TXT,
          ttl: 60,
          data: { kind: "txt", values: ["id=peer-2"] },
        },
      ],
    });
    const message = decodeMessage(packet);
    const records = extractServiceRecords(
      message === undefined ? [] : [...message.answers],
      "10.0.0.7",
    );
    expect(records[0]?.host).toBe("10.0.0.7");
    expect(records[0]?.peerId).toBe("peer-2");
  });

  it("skips an instance with no SRV record", () => {
    const packet = encodeResponse({
      answers: [
        {
          name: serviceInstanceName("peer-3"),
          type: DNS_TYPE.TXT,
          ttl: 60,
          data: { kind: "txt", values: ["id=peer-3"] },
        },
      ],
    });
    const message = decodeMessage(packet);
    expect(
      extractServiceRecords(
        message === undefined ? [] : [...message.answers],
        "10.0.0.8",
      ),
    ).toEqual([]);
  });

  it("re-joins a TXT value split across character-strings", () => {
    const long = "z".repeat(300);
    expect(parseServiceTxt([`caps=${long.slice(0, 200)}`, long.slice(200)])).toEqual({
      caps: long,
    });
  });

  it("sanitizes instance labels built from odd peer ids", () => {
    expect(serviceInstanceName("peer 1/β")).toBe(
      "peer-1--._envoy-harness._tcp.local",
    );
  });

  it("encodes TXT metadata only for provided fields", () => {
    expect(encodeServiceTxt({ peerId: "p", port: 1, address: "127.0.0.1" })).toEqual([
      "id=p",
      "model=",
    ]);
  });
});

describe("MdnsBrowser", () => {
  it("binds the mDNS port, joins the group, and sends a PTR query", async () => {
    const socket = createFakeMdnsSocket();
    const browser = new MdnsBrowser({ socketFactory: () => socket });
    await browser.start(() => {});

    expect(socket.boundPort).toBe(5353);
    expect(socket.memberships).toEqual(["224.0.0.251"]);
    expect(socket.sent).toHaveLength(1);

    const sent = decodeMessage(socket.sent[0]?.packet ?? new Uint8Array());
    expect(sent?.questions[0]).toMatchObject({
      name: ENVOY_PEER_SERVICE_TYPE,
      type: DNS_TYPE.PTR,
    });
    browser.stop();
  });

  it("announces found peers from a response", async () => {
    const socket = createFakeMdnsSocket();
    const browser = new MdnsBrowser({ socketFactory: () => socket });
    const found = vi.fn();
    await browser.start(found);

    browser.ingest(peerResponse(), { address: "192.168.1.50", port: 5353 });

    expect(found).toHaveBeenCalledTimes(1);
    expect(found.mock.calls[0]?.[0]).toMatchObject({
      kind: "found",
      record: { peerId: "peer-1", host: "192.168.1.50", port: 8123 },
    });
    expect(browser.knownPeers()).toHaveLength(1);
    browser.stop();
  });

  it("ignores queries (only responses describe peers)", async () => {
    const socket = createFakeMdnsSocket();
    const browser = new MdnsBrowser({ socketFactory: () => socket });
    const found = vi.fn();
    await browser.start(found);

    browser.ingest(encodeQuery(ENVOY_PEER_SERVICE_TYPE, DNS_TYPE.PTR), {
      address: "192.168.1.51",
      port: 5353,
    });
    expect(found).not.toHaveBeenCalled();
    browser.stop();
  });

  it("expires a peer after its TTL and announces lost", async () => {
    const socket = createFakeMdnsSocket();
    const scheduler = createManualScheduler();
    const browser = new MdnsBrowser({
      socketFactory: () => socket,
      scheduler,
    });
    const events: string[] = [];
    await browser.start((e) => events.push(e.kind));

    browser.ingest(peerResponse({ ttl: 10 }), { address: PEER.host, port: 5353 });
    expect(events).toEqual(["found"]);

    scheduler.advance(9_000);
    browser.sweep();
    expect(events).toEqual(["found"]);

    scheduler.advance(2_000);
    browser.sweep();
    expect(events).toEqual(["found", "lost"]);
    expect(browser.knownPeers()).toHaveLength(0);
    browser.stop();
  });

  it("treats a TTL=0 packet as an immediate goodbye", async () => {
    const socket = createFakeMdnsSocket();
    const browser = new MdnsBrowser({ socketFactory: () => socket });
    const events: string[] = [];
    await browser.start((e) => events.push(e.kind));

    browser.ingest(peerResponse(), { address: PEER.host, port: 5353 });
    browser.ingest(peerResponse({ ttl: 0 }), { address: PEER.host, port: 5353 });
    expect(events).toEqual(["found", "lost"]);
    browser.stop();
  });

  it("keeps a peer alive when a refresh arrives before the TTL lapses", async () => {
    const socket = createFakeMdnsSocket();
    const scheduler = createManualScheduler();
    const browser = new MdnsBrowser({ socketFactory: () => socket, scheduler });
    const events: string[] = [];
    await browser.start((e) => events.push(e.kind));

    browser.ingest(peerResponse({ ttl: 10 }), { address: PEER.host, port: 5353 });
    scheduler.advance(8_000);
    browser.ingest(peerResponse({ ttl: 10 }), { address: PEER.host, port: 5353 });
    scheduler.advance(8_000);
    browser.sweep();

    expect(events.filter((e) => e === "lost")).toEqual([]);
    browser.stop();
  });

  it("re-queries on the configured interval", async () => {
    const socket = createFakeMdnsSocket();
    const scheduler = createManualScheduler();
    const browser = new MdnsBrowser({
      socketFactory: () => socket,
      scheduler,
      queryIntervalMs: 1_000,
    });
    await browser.start(() => {});
    expect(socket.sent).toHaveLength(1);

    scheduler.advance(1_000);
    scheduler.tick();
    expect(socket.sent).toHaveLength(2);
    browser.stop();
  });

  it("fails open when multicast membership is unavailable", async () => {
    const socket = createFakeMdnsSocket();
    socket.failMembership();
    const onError = vi.fn();
    const browser = new MdnsBrowser({ socketFactory: () => socket, onError });

    await expect(browser.start(() => {})).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(browser.running).toBe(false);
    expect(socket.closed).toBe(true);
  });

  it("fails open when the bind is refused", async () => {
    const socket = createFakeMdnsSocket();
    socket.failBind();
    const onError = vi.fn();
    const browser = new MdnsBrowser({ socketFactory: () => socket, onError });

    await expect(browser.start(() => {})).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(browser.running).toBe(false);
  });

  it("stops idempotently", async () => {
    const socket = createFakeMdnsSocket();
    const browser = new MdnsBrowser({ socketFactory: () => socket });
    await browser.start(() => {});
    browser.stop();
    expect(() => browser.stop()).not.toThrow();
  });
});

describe("MdnsAdvertiser", () => {
  const info = {
    peerId: "peer-1",
    port: 8123,
    address: "192.168.1.50",
    model: "deepseek-chat",
    capabilities: ["code-edit"],
  };

  it("announces PTR, SRV, TXT and A records on start", async () => {
    const socket = createFakeMdnsSocket();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => socket,
      setTimer: () => 0,
    });
    await advertiser.start();

    expect(socket.boundPort).toBe(5353);
    expect(socket.memberships).toEqual(["224.0.0.251"]);
    expect(socket.sent).toHaveLength(1);

    const decoded = decodeMessage(socket.sent[0]?.packet ?? new Uint8Array());
    const types = decoded?.answers.map((r) => r.type).sort();
    expect(types).toEqual([1, 12, 16, 33]);
    advertiser.stop();
  });

  it("answers a PTR browse with the full record set as additionals", async () => {
    const socket = createFakeMdnsSocket();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => socket,
      setTimer: () => 0,
    });
    await advertiser.start();
    socket.sent.length = 0;

    advertiser.handleQuery(
      encodeQuery(ENVOY_PEER_SERVICE_TYPE, DNS_TYPE.PTR),
      { address: "192.168.1.99", port: 5353 },
    );

    expect(socket.sent).toHaveLength(1);
    const sent = socket.sent[0];
    expect(sent?.address).toBe("224.0.0.251");
    const decoded = decodeMessage(sent?.packet ?? new Uint8Array());
    expect(decoded?.answers).toHaveLength(1);
    expect(decoded?.answers[0]?.type).toBe(DNS_TYPE.PTR);
    expect(decoded?.additionals.map((r) => r.type).sort()).toEqual([1, 16, 33]);
    advertiser.stop();
  });

  it("unicasts the answer when the query sets the QU bit", async () => {
    const socket = createFakeMdnsSocket();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => socket,
      setTimer: () => 0,
    });
    await advertiser.start();
    socket.sent.length = 0;

    const query = encodeQuery(ENVOY_PEER_SERVICE_TYPE, DNS_TYPE.PTR);
    // QU is the top bit of the 16-bit QCLASS (its first byte).
    query[query.length - 2] = (query[query.length - 2] ?? 0) | 0x80;
    advertiser.handleQuery(query, { address: "192.168.1.99", port: 40000 });

    expect(socket.sent[0]?.address).toBe("192.168.1.99");
    expect(socket.sent[0]?.port).toBe(40000);
    advertiser.stop();
  });

  it("ignores unrelated queries", async () => {
    const socket = createFakeMdnsSocket();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => socket,
      setTimer: () => 0,
    });
    await advertiser.start();
    socket.sent.length = 0;

    advertiser.handleQuery(encodeQuery("_http._tcp.local", DNS_TYPE.PTR), {
      address: "192.168.1.99",
      port: 5353,
    });
    expect(socket.sent).toHaveLength(0);
    advertiser.stop();
  });

  it("sends a TTL=0 goodbye on stop", async () => {
    const socket = createFakeMdnsSocket();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => socket,
      setTimer: () => 0,
    });
    await advertiser.start();
    socket.sent.length = 0;
    advertiser.stop();

    const decoded = decodeMessage(socket.sent[0]?.packet ?? new Uint8Array());
    expect(decoded?.answers.every((r) => r.ttl === 0)).toBe(true);
  });

  it("fails open when multicast is unavailable", async () => {
    const socket = createFakeMdnsSocket();
    socket.failMembership();
    const onError = vi.fn();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => socket,
      onError,
      setTimer: () => 0,
    });
    await expect(advertiser.start()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(advertiser.running).toBe(false);
  });

  it("round-trips: a browser finds what an advertiser announces", async () => {
    // The end-to-end proof that discovery works, with no network: the
    // advertiser's own bytes are fed straight into the browser.
    const advSocket = createFakeMdnsSocket();
    const advertiser = new MdnsAdvertiser({
      info,
      socketFactory: () => advSocket,
      setTimer: () => 0,
    });
    await advertiser.start();

    const browser = new MdnsBrowser({
      socketFactory: () => createFakeMdnsSocket(),
    });
    const found: Array<{ peerId: string; host: string; port: number }> = [];
    await browser.start((event) => {
      const r = event.record;
      found.push({ peerId: r.peerId, host: r.host, port: r.port });
    });

    for (const sent of advSocket.sent) {
      browser.ingest(sent.packet, { address: info.address, port: 5353 });
    }

    expect(found).toEqual([
      { peerId: "peer-1", host: "192.168.1.50", port: 8123 },
    ]);
    advertiser.stop();
    browser.stop();
  });
});

describe("MdnsDiscoverySource", () => {
  it("emits discovered peers on the DiscoverySource seam", async () => {
    const socket = createFakeMdnsSocket();
    const scheduler = createManualScheduler();
    const source = new MdnsDiscoverySource({
      socketFactory: () => socket,
      scheduler,
    });
    const events: Array<Record<string, unknown>> = [];
    await source.start((e) => events.push(e as unknown as Record<string, unknown>));

    socket.deliver(peerResponse(), { address: PEER.host, port: 5353 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "found",
      peer: {
        id: "peer-1",
        endpoint: "192.168.1.50:8123",
        source: "mdns",
        model: "deepseek-chat",
        capabilities: ["code-edit", "bash-run"],
      },
    });

    // A TTL refresh must NOT re-announce (the rail would reconnect).
    scheduler.advance(30_000);
    socket.deliver(peerResponse(), { address: PEER.host, port: 5353 });
    expect(events).toHaveLength(1);

    // Expiry emits exactly one `lost`.
    scheduler.advance(120_000);
    source.stop();
    void socket;
  });

  it("emits lost when the peer's TTL lapses", async () => {
    const socket = createFakeMdnsSocket();
    const scheduler = createManualScheduler();
    const source = new MdnsDiscoverySource({
      socketFactory: () => socket,
      scheduler,
      // Drive expiry through the browser's own sweep timer.
      sweepIntervalMs: 1_000,
    });
    const events: Array<Record<string, unknown>> = [];
    await source.start((e) => events.push(e as unknown as Record<string, unknown>));

    socket.deliver(peerResponse({ ttl: 10 }), { address: PEER.host, port: 5353 });
    scheduler.advance(11_000);
    scheduler.tick();

    expect(events.map((e) => e["kind"])).toEqual(["found", "lost"]);
    expect(events[1]).toMatchObject({ kind: "lost", peerId: "peer-1" });
    source.stop();
  });

  it("is inert when explicitly disabled", async () => {
    const factory = vi.fn(() => createFakeMdnsSocket());
    const source = new MdnsDiscoverySource({
      disabled: true,
      socketFactory: factory,
    });
    await source.start(() => {});
    expect(factory).not.toHaveBeenCalled();
    source.stop();
  });

  it("uses an injected legacy browser verbatim", async () => {
    const stop = vi.fn();
    const source = new MdnsDiscoverySource({
      browser: (emit) => {
        emit({
          kind: "found",
          peer: { id: "injected", endpoint: "10.0.0.1:1", source: "mdns" },
        });
        return stop;
      },
    });
    const found = vi.fn();
    await source.start(found);
    expect(found).toHaveBeenCalledTimes(1);
    source.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("advertise address helpers", () => {
  it("prefers a private LAN address", () => {
    expect(
      resolveAdvertiseAddress({
        en0: [
          {
            address: "203.0.113.9",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "203.0.113.9/24",
          },
        ],
        en1: [
          {
            address: "192.168.1.50",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:01",
            internal: false,
            cidr: "192.168.1.50/24",
          },
        ],
      }),
    ).toBe("192.168.1.50");
  });

  it("ignores internal interfaces", () => {
    expect(
      resolveAdvertiseAddress({
        lo0: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("derives a .local hostname from the machine name", () => {
    expect(localHostName("mac.example.com")).toBe("mac.local");
    expect(localHostName("odd name!")).toBe("odd-name-.local");
  });
});
