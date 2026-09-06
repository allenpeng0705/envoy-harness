import { describe, expect, it } from "vitest";

import {
  attachSdkServer,
  createFakeSessionBackend,
  createInProcessJsonRpcPair,
} from "../../src/protocol/index.js";

describe("SDK server", () => {
  it("session/create + tools/list + config/get + prompt", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({
      config: { model: "fake" },
      tools: [{ name: "read_file", description: "Read a file" }],
    });
    attachSdkServer({ connection: pair.server, backend });

    const events: unknown[] = [];
    pair.client.setNotificationHandler((method, params) => {
      if (method === "session/event") events.push(params);
    });

    const { sessionId } = (await pair.client.request("session/create", {})) as {
      sessionId: string;
    };
    const tools = (await pair.client.request("tools/list", {})) as {
      tools: Array<{ name: string }>;
    };
    expect(tools.tools[0]?.name).toBe("read_file");

    const config = (await pair.client.request("config/get", {})) as {
      model: string;
    };
    expect(config.model).toBe("fake");

    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "sdk-hi" },
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(events.length).toBeGreaterThanOrEqual(1);
    pair.close();
  });

  it("session/user_question round-trip", async () => {
    const pair = createInProcessJsonRpcPair();
    const backend = createFakeSessionBackend({
      userQuestion: { prompt: "Ship it?", options: ["y", "n"] },
    });
    attachSdkServer({ connection: pair.server, backend });

    pair.client.setRequestHandler(async (method, params) => {
      if (method === "session/user_question") {
        expect(params).toMatchObject({ prompt: "Ship it?" });
        return { value: "y", optionIndex: 0, cancelled: false };
      }
      throw new Error(`unexpected ${method}`);
    });

    const { sessionId } = (await pair.client.request("session/create", {})) as {
      sessionId: string;
    };
    const result = (await pair.client.request("session/prompt", {
      sessionId,
      prompt: { text: "go" },
    })) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(backend.userAnswers[0]?.value).toBe("y");
    pair.close();
  });
});
