/**
 * Optional Playwright e2e smoke — real Chromium against a local static page.
 * Skipped unless ENVOY_WEB_SMOKE=1 (requires `npx playwright install chromium`).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  browserClickTool,
  browserCloseTool,
  browserConsoleTool,
  browserNavigateTool,
  browserNetworkTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserTypeTool,
  setBrowserSessionManager,
} from "../../src/tools/builtin/browser/index.js";
import { isMultimodalToolContent } from "../../src/tools/multimodal.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { Session } from "../../src/session.js";

const enabled = process.env["ENVOY_WEB_SMOKE"] === "1";

describe.skipIf(!enabled)("web e2e smoke (ENVOY_WEB_SMOKE=1)", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    setBrowserSessionManager(undefined);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html><body>
  <h1>envoy-web-smoke</h1>
  <label>Name <input id="name" name="name" /></label>
  <button id="go" type="button">Go</button>
  <script>
    document.getElementById("go").onclick = () => {
      console.log("clicked");
      document.body.dataset.ready = "1";
    };
  </script>
</body></html>`);
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

  function ctx(): ToolContext {
    return {
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
  }

  it("full loop: navigate → type/click → snapshot/screenshot → console/network", async () => {
    const c = ctx();
    const nav = await browserNavigateTool.execute({ url: baseUrl }, c);
    expect(nav.isError).toBeUndefined();

    const typed = await browserTypeTool.execute(
      { selector: "#name", text: "envoy", clear: true },
      c,
    );
    expect(typed.isError).toBeUndefined();

    const clicked = await browserClickTool.execute({ selector: "#go" }, c);
    expect(clicked.isError).toBeUndefined();

    const snap = await browserSnapshotTool.execute({}, c);
    expect(snap.isError).toBeUndefined();
    expect(String(snap.content)).toMatch(/envoy-web-smoke|WebArea|button/i);

    const shot = await browserScreenshotTool.execute({}, c);
    expect(shot.isError).toBeUndefined();
    expect(isMultimodalToolContent(shot.content)).toBe(true);

    const cons = await browserConsoleTool.execute({}, c);
    expect(cons.isError).toBeUndefined();

    const net = await browserNetworkTool.execute({}, c);
    expect(String(net.content)).toContain(baseUrl.replace(/\/$/, ""));

    await browserCloseTool.execute({}, c);
  }, 90_000);
});
