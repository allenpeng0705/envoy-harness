/**
 * F8.4+ tests — `defaultSignResult` helper.
 *
 * Covers:
 * 1. Real Ed25519 round-trip: sign an unsigned result,
 *    verify the signature, recover the canonical JSON.
 * 2. The signature covers `raw` (the audit field).
 * 3. Different keys produce different signatures.
 * 4. `defaultSignResultFromKeyPair` accepts a key pair object.
 * 5. The returned closure is reusable (signs multiple
 *    results in series).
 */

import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, signCanonicalPayload, verifyCanonicalPayload } from "@envoymesh/identity";
import type { AgentResult as WireAgentResult } from "@envoymesh/protocol";

import { defaultSignResult, defaultSignResultFromKeyPair } from "../src/signing.js";

function makeUnsigned(): WireAgentResult {
  return {
    skillId: "code-review",
    runtime: "envoy-harness",
    peerId: "peer-1",
    correlationId: "corr-1",
    content: [{ kind: "text", text: "the diff looks fine" }],
    citations: [],
    metrics: { durationMs: 100, costUsd: 0.05 },
    completedAt: new Date().toISOString(),
  };
}

describe("defaultSignResult — real Ed25519", () => {
  it("returns a closure that signs with the given key", () => {
    const key = generateEd25519KeyPair();
    const sign = defaultSignResult(key.privateKeyPem);
    const signed = sign(makeUnsigned());
    expect(signed.signature).toBeTruthy();
    expect(signed.signature.length).toBeGreaterThan(0);
  });

  it("the signature is verifiable with the public key", () => {
    const key = generateEd25519KeyPair();
    const sign = defaultSignResult(key.privateKeyPem);
    const unsigned = makeUnsigned();
    const signed = sign(unsigned);
    // verifyCanonicalPayload re-derives the canonical JSON
    // internally (matching the signer's canonicalization).
    const verified = verifyCanonicalPayload(unsigned, signed.signature, key.publicKeyPem);
    expect(verified).toBe(true);
  });

  it("the signature covers `raw` (the audit field)", () => {
    const key = generateEd25519KeyPair();
    const sign = defaultSignResult(key.privateKeyPem);
    const unsigned: WireAgentResult = {
      ...makeUnsigned(),
      raw: { secretAudit: "lossless local result" },
    };
    const signed = sign(unsigned);
    // Reconstruct what was signed (the canonical JSON of
    // the full unsigned result, including `raw`).
    const verified = verifyCanonicalPayload(unsigned, signed.signature, key.publicKeyPem);
    expect(verified).toBe(true);
  });

  it("a different key produces a different signature", () => {
    const key1 = generateEd25519KeyPair();
    const key2 = generateEd25519KeyPair();
    const sign1 = defaultSignResult(key1.privateKeyPem);
    const sign2 = defaultSignResult(key2.privateKeyPem);
    const unsigned = makeUnsigned();
    const signed1 = sign1(unsigned);
    const signed2 = sign2(unsigned);
    expect(signed1.signature).not.toBe(signed2.signature);
  });

  it("the closure is reusable for multiple results", () => {
    const key = generateEd25519KeyPair();
    const sign = defaultSignResult(key.privateKeyPem);
    // Capture base once — makeUnsigned() generates a fresh
    // `completedAt` on each call, so we can't re-derive
    // when verifying.
    const base = makeUnsigned();
    const r1 = sign({ ...base, correlationId: "c1" });
    const r2 = sign({ ...base, correlationId: "c2" });
    expect(r1.signature).not.toBe(r2.signature);
    // Both verifiable (re-derive the same payload)
    expect(verifyCanonicalPayload({ ...base, correlationId: "c1" }, r1.signature, key.publicKeyPem)).toBe(true);
    expect(verifyCanonicalPayload({ ...base, correlationId: "c2" }, r2.signature, key.publicKeyPem)).toBe(true);
  });
});

describe("defaultSignResultFromKeyPair", () => {
  it("accepts a key pair object and produces a working closure", () => {
    const key = generateEd25519KeyPair();
    const sign = defaultSignResultFromKeyPair(key);
    const signed = sign(makeUnsigned());
    expect(signed.signature).toBeTruthy();
    expect(verifyCanonicalPayload(makeUnsigned(), signed.signature, key.publicKeyPem)).toBe(true);
  });
});

describe("signature contract — matches signCanonicalPayload directly", () => {
  it("defaultSignResult's output equals a direct signCanonicalPayload call", () => {
    const key = generateEd25519KeyPair();
    const sign = defaultSignResult(key.privateKeyPem);
    const unsigned = makeUnsigned();
    const signed = sign(unsigned);
    const direct = signCanonicalPayload(unsigned, key.privateKeyPem);
    expect(signed.signature).toBe(direct);
  });
});
