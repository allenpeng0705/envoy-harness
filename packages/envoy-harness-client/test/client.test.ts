/**
 * Client package tests — in-process against harness protocol servers.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  attachAcpServer,
  attachSdkServer,
  createFakeSessionBackend,
  JsonRpcConnection,
} from "@envoymesh/envoy-harness";

import { EnvoyHarnessClient } from "../src/index.js";

function pairedClientAndServer(): {
  client: EnvoyHarnessClient;
  server: JsonRpcConnection;
  close(): void;
} {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const server = new JsonRpcConnection({ input: c2s, output: s2c });
  const client = new EnvoyHarnessClient({
    input: s2c,
    output: c2s,
    onPermissionRequest: async () => "allow",
  });
  return {
    client,
    server,
    close() {
      client.close();
      server.close();
      c2s.destroy();
      s2c.destroy();
    },
  };
}

describe("EnvoyHarnessClient", () => {
  it("drives SDK dialect end-to-end", async () => {
    const pair = pairedClientAndServer();
    attachSdkServer({
      connection: pair.server,
      backend: createFakeSessionBackend({
        tools: [{ name: "bash", description: "shell" }],
      }),
    });

    const { sessionId } = await pair.client.createSession();
    const tools = await pair.client.listTools();
    expect(tools[0]?.name).toBe("bash");
    const result = await pair.client.prompt(sessionId, "ping");
    expect(result.stopReason).toBe("end_turn");
    pair.close();
  });

  it("ACP initialize + prompt", async () => {
    const pair = pairedClientAndServer();
    attachAcpServer({
      connection: pair.server,
      backend: createFakeSessionBackend(),
    });
    const init = await pair.client.initialize();
    expect(init.protocolVersion).toBe(1);
    const { sessionId } = await pair.client.acpNewSession();
    const result = await pair.client.prompt(sessionId, "acp");
    expect(result.messages.at(-1)).toMatchObject({ text: "echo:acp" });
    pair.close();
  });
});
