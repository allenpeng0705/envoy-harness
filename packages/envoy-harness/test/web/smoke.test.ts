/**
 * Optional Playwright smoke — navigate + screenshot against a local static page.
 * Skipped unless ENVOY_WEB_SMOKE=1.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  browserCloseTool,
  browserNavigateTool,
  browserScreenshotTool,
  setBrowserSessionManager,
} from "../../src/tools/builtin/browser/index.js";
import { isMultimodalToolContent } from "../../src/tools/multimodal.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { Session } from "../../src/session.js";

const enabled = process.env["ENVOY_WEB_SMOKE"] === "1";

describe.skipIf(!enabled)("web smoke (ENVOY_WEB_SMOKE=1)", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    setBrowserSessionManager(undefined);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>envoy-web-smoke</h1></body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/`;
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
  });

  afterAll(async () => {
    await closeServer?.();
    setBrowserSessionManager(undefined);
  });

  it("navigates and screenshots", async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      session: { id: "web-smoke" } as Session,
      abortSignal: new AbortController().signal,
      sandboxPolicy: {
        mode: "danger-full-access",
        approval: "never",
        backend: "none",
        writableRoots: [],
        networkAccess: true,
        slashTmpWritable: true,
      },
    };
    const nav = await browserNavigateTool.execute({ url: baseUrl }, ctx);
    expect(nav.isError).toBeUndefined();
    const shot = await browserScreenshotTool.execute({}, ctx);
    expect(shot.isError).toBeUndefined();
    expect(isMultimodalToolContent(shot.content)).toBe(true);
    await browserCloseTool.execute({}, ctx);
  }, 60_000);
});
