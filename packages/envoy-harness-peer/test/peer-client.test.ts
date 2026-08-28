/**
 * D2 — PeerClient over the in-process pair: ping, submit, unknown
 * methods, abort, and round-trip fidelity.
 */

import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  JsonRpcConnection,
  type SubagentInput,
} from "@envoymesh/envoy-harness";
import type { ExecuteInput } from "@envoymesh/agent-adapter";

import {
  createInProcessPeerPair,
  createPeerServerHandler,
  PeerClient,
} from "../src/index.js";
import { signedResult, stubAdapter } from "./helpers.js";

const INPUT: SubagentInput = {
  objective: "research feasibility",
  capabilityTag: "research",
  costCeilingUsd: 1,
  deadlineMs: 10_000,
};

describe("PeerClient (in-process pair, MAP-shaped)", () => {
  it("pings and round-trips a MAP execute result unchanged", async () => {
    const result = signedResult();
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({ execute: async () => result }),
        identity: { peerId: "peer-1", model: "deepseek-chat" },
      }),
    );

    const ping = await pair.client.ping();
    expect(ping).toEqual({ ok: true, peerId: "peer-1", model: "deepseek-chat" });

    const executeInput: ExecuteInput = {
      skillId: "research",
      objective: "research feasibility",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-1",
      signal: new AbortController().signal,
    };
    const executed = await pair.client.execute(executeInput);
    expect(executed).toEqual(result);
    expect(executed.correlationId).toBe("corr-1");
    pair.close();
  });

  it("applies submitResponseBufferMs on top of the task deadline", async () => {
    const request = vi.fn(async () => ({
      result: signedResult({ correlationId: "corr-buffer" }),
    }));
    const connection = {
      request,
      notify: vi.fn(),
      close: vi.fn(),
      closed: false,
      on: vi.fn(),
    } as unknown as JsonRpcConnection;
    const client = new PeerClient({
      connection,
      submitResponseBufferMs: 2_000,
    });
    const input: ExecuteInput = {
      skillId: "research",
      objective: "x",
      inputArtifacts: [],
      costCeilingUsd: 1,
      deadlineMs: 10_000,
      correlationId: "corr-buffer",
      signal: new AbortController().signal,
    };
    const response = await client.executeWithVerdict(input);
    expect(response.result.correlationId).toBe("corr-buffer");
    expect(request).toHaveBeenCalledWith(
      "peer/submit",
      input,
      12_000, // deadlineMs + buffer
    );
  });

  it("rejects unknown methods with a clear error", async () => {
    // A raw client connection (not PeerClient) sending a method the peer
    // handler doesn't know → the server rejects with a clear error.
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new JsonRpcConnection({
      input: clientToServer,
      output: serverToClient,
      onRequest: createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "peer-1" },
      }),
    });
    const rawClient = new JsonRpcConnection({
      input: serverToClient,
      output: clientToServer,
    });
    await expect(rawClient.request("peer/unknown")).rejects.toThrow(
      /unknown peer method/,
    );
    server.close?.();
    clientToServer.destroy();
    serverToClient.destroy();
  });

  it("aborts a submit when the signal fires", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter({
          // Never settles — only the abort path finishes it.
          execute: () => new Promise(() => {}) as never,
        }),
        identity: { peerId: "peer-1" },
      }),
    );
    const controller = new AbortController();
    const pending = pair.client.execute(
      {
        skillId: "research",
        objective: "x",
        inputArtifacts: [],
        costCeilingUsd: 1,
        deadlineMs: 10_000,
        correlationId: "c",
        signal: controller.signal,
      },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    pair.close();
  });

  it("reports the correct abort message for verify/manifest", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "peer-1" },
      }),
    );
    const controller = new AbortController();
    const pendingVerify = pair.client.verify(
      {
        result: signedResult(),
        objective: "x",
      },
      controller.signal,
    );
    controller.abort();
    await expect(pendingVerify).rejects.toThrow("peer verify aborted");
    pair.close();
  });
});

describe("PeerMeshSubmitter", () => {
  it("implements the MeshSubmitter contract and tracks spawned peers", async () => {
    const pair = createInProcessPeerPair(
      createPeerServerHandler({
        adapter: stubAdapter(),
        identity: { peerId: "peer-1" },
      }),
    );
    const { PeerMeshSubmitter } = await import("../src/index.js");
    const submitter = new PeerMeshSubmitter({ client: pair.client });
    const result = await submitter.submit(INPUT, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(result.workerPeerId).toBe("peer-1");
    expect(submitter.listSubagents()).toHaveLength(1);
    pair.close();
  });
});
