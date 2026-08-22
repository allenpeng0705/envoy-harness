/**
 * D7 — hardening: signed peer envelopes + observability events.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalPeerPayload,
  createPeerServerHandler,
  unwrapEnvelope,
  wrapEnvelope,
  type PeerEvent,
  type PeerSigner,
  type PeerVerifier,
} from "../src/index.js";
import { stubAdapter } from "./helpers.js";

/** A deterministic HMAC-style sign/verify pair (hosts use Ed25519). */
function hmacPair(secret: string): { signer: PeerSigner; verifier: PeerVerifier } {
  const hmac = (payload: string) =>
    createHash("sha256").update(`${secret}:${payload}`).digest("hex");
  return {
    signer: { sign: hmac },
    verifier: {
      verify: (payload, signature) => hmac(payload) === signature,
    },
  };
}

describe("signed peer envelopes (D7)", () => {
  it("round-trips a signed envelope over the wire", () => {
    const { signer, verifier } = hmacPair("s3cret");
    const wrapped = wrapEnvelope("peer/submit", { objective: "x" }, signer.sign.bind(signer));
    expect(unwrapEnvelope("peer/submit", wrapped, verifier.verify.bind(verifier))).toEqual({
      objective: "x",
    });
    expect(() =>
      unwrapEnvelope("peer/submit", wrapped, hmacPair("wrong").verifier.verify),
    ).toThrow(/verification failed/);
  });

  it("rejects a client with the wrong signer at the server", async () => {
    const serverKey = hmacPair("server-secret");
    const { JsonRpcConnection } = await import("@envoymesh/envoy-harness");
    const { PassThrough } = await import("node:stream");
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new JsonRpcConnection({
      input: clientToServer,
      output: serverToClient,
      onRequest: createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "p1" },
        verifier: serverKey.verifier,
      }),
    });
    const { PeerClient } = await import("../src/index.js");
    const wrongClient = new PeerClient({
      connection: new JsonRpcConnection({ input: serverToClient, output: clientToServer }),
      signer: hmacPair("attacker").signer,
    });
    await expect(
      wrongClient.execute({
        skillId: "research",
        objective: "x",
        inputArtifacts: [],
        costCeilingUsd: 1,
        deadlineMs: 10_000,
        correlationId: "c",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/verification failed/);
    server.close?.();
    clientToServer.destroy();
    serverToClient.destroy();
  });

  it("canonical payload is deterministic", () => {
    expect(canonicalPeerPayload("peer/ping", { a: 1 })).toBe(
      canonicalPeerPayload("peer/ping", { a: 1 }),
    );
  });
});

describe("peer observability events (D7)", () => {
  it("emits request/response events on the client", async () => {
    const events: PeerEvent[] = [];
    const { JsonRpcConnection } = await import("@envoymesh/envoy-harness");
    const { PassThrough } = await import("node:stream");
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new JsonRpcConnection({
      input: clientToServer,
      output: serverToClient,
      onRequest: createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "p1" },
      }),
    });
    const { PeerClient } = await import("../src/index.js");
    const client = new PeerClient({
      connection: new JsonRpcConnection({ input: serverToClient, output: clientToServer }),
      onEvent: (e) => events.push(e),
    });
    await client.ping();
    expect(events.some((e) => e.type === "peer.request" && e.method === "peer/ping")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "peer.response" && e.method === "peer/ping" && e.ok === true,
      ),
    ).toBe(true);
    server.close?.();
    clientToServer.destroy();
    serverToClient.destroy();
  });
});
