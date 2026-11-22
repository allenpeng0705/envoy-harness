/**
 * Complex multi-step task e2e — scripted model drives the full Agent
 * loop through discover → edit → verify flows that leave real artifacts.
 *
 * These are hermetic (FakeModel + mocked Playwright). They prove the
 * harness can complete non-trivial work end-to-end, not just unit-level
 * tool calls.
 */

import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Agent,
  HookRegistry,
  InMemorySession,
  LocalMeshSubmitter,
  ToolRegistry,
  applyPatchTool,
  bashTool,
  defaultBuildSubagentFactory,
  makeGlobTool,
  makeGrepTool,
  newSessionId,
  readFileTool,
  writeTool,
  type ModelAdapter,
} from "../src/index.js";
import {
  browserCloseTool,
  browserConsoleTool,
  browserNavigateTool,
  browserSnapshotTool,
  setBrowserSessionManager,
  type BrowserConsoleEntry,
  type BrowserPageHandle,
  type BrowserSessionManager,
  type BrowserSnapshotRef,
} from "../src/tools/builtin/browser/index.js";
import { FakeModel, textResponse, toolCall } from "./fixtures/fake-model.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-complex-"));
});

afterEach(async () => {
  setBrowserSessionManager(undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function workspaceAgent(
  model: FakeModel | ModelAdapter,
  tools: ToolRegistry,
): Agent {
  return new Agent({
    model,
    tools,
    hooks: new HookRegistry(),
    session: new InMemorySession(newSessionId(), {
      cwd: tmpDir,
      permissionMode: "workspace-write",
      startedAt: new Date().toISOString(),
    }),
    cwd: tmpDir,
  });
}

function registerFsTools(tools: ToolRegistry): void {
  tools.register(readFileTool);
  tools.register(writeTool);
  tools.register(applyPatchTool);
  tools.register(bashTool);
  tools.register(makeGlobTool());
  tools.register(makeGrepTool());
}

function toolResultTexts(agent: Agent): string[] {
  const out: string[] = [];
  for (const m of agent.session.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push(
          typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        );
      }
    }
  }
  return out;
}

function mockSpaPage(state: {
  url: string;
  title: string;
  bodyText: string;
  console: BrowserConsoleEntry[];
}): BrowserPageHandle & { refs: Map<string, string> } {
  const refs = new Map<string, string>();
  return {
    refs,
    async goto(next) {
      state.url = next;
      state.console.push({
        type: "log",
        text: `navigated ${next}`,
        timestamp: Date.now(),
      });
    },
    async accessibilitySnapshot() {
      return {
        role: "WebArea",
        name: state.title,
        children: [
          { role: "heading", name: state.title },
          { role: "button", name: "Submit" },
          { role: "StaticText", name: state.bodyText },
        ],
      };
    },
    async click() {},
    async type() {},
    async press() {},
    async screenshot() {
      return Buffer.from("png");
    },
    url: () => state.url,
    setRefs(next: ReadonlyArray<BrowserSnapshotRef>) {
      refs.clear();
      for (const r of next) refs.set(r.ref, r.selector);
    },
    resolveRef(ref) {
      return refs.get(ref);
    },
    getConsole(limit = 50) {
      return state.console.slice(-limit);
    },
    getNetwork() {
      return [];
    },
  };
}

function mockManager(page: BrowserPageHandle): BrowserSessionManager {
  const pages = new Map<string, BrowserPageHandle>();
  return {
    async ensurePage(key) {
      pages.set(key, page);
      return page;
    },
    getPage(key) {
      return pages.get(key);
    },
    async close(key) {
      pages.delete(key);
    },
    async closeAll() {
      pages.clear();
    },
  };
}

describe("complex task: fix broken calculator end-to-end", () => {
  it("glob → grep → read → apply_patch → bash verify → summarize", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "math.js"),
      [
        "export function add(a, b) {",
        "  return a - b; // BUG: should add",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "check.mjs"),
      [
        "import { add } from './math.js';",
        "const got = add(2, 3);",
        "if (got !== 5) {",
        "  console.error('FAIL add(2,3)=' + got);",
        "  process.exit(1);",
        "}",
        "console.log('PASS');",
        "",
      ].join("\n"),
      "utf8",
    );

    const tools = new ToolRegistry();
    registerFsTools(tools);
    const model = new FakeModel([
      { content: [toolCall("t1", "glob", { pattern: "**/*.{js,mjs}" })] },
      {
        content: [
          toolCall("t2", "grep", {
            pattern: "function add",
            glob: "**/*.{js,mjs}",
          }),
        ],
      },
      {
        content: [
          toolCall("t3", "read_file", {
            path: path.join(tmpDir, "src", "math.js"),
          }),
        ],
      },
      {
        content: [
          toolCall("t4", "apply_patch", {
            patch: `*** Begin Patch
*** Update File: src/math.js
 export function add(a, b) {
-  return a - b; // BUG: should add
+  return a + b;
 }
*** End Patch`,
          }),
        ],
      },
      {
        content: [
          toolCall("t5", "bash", {
            command: "node src/check.mjs",
          }),
        ],
      },
      textResponse("Fixed add() and verified with check.mjs (PASS)."),
    ]);

    const agent = workspaceAgent(model, tools);
    const result = await agent.run(
      "add(2,3) returns the wrong value. Find and fix the bug, then run the check.",
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(6);
    expect(result.toolCalls).toBe(5);

    const fixed = await fs.readFile(path.join(tmpDir, "src", "math.js"), "utf8");
    expect(fixed).toContain("return a + b;");
    expect(fixed).not.toContain("a - b");

    const results = toolResultTexts(agent);
    expect(results.some((r) => r.includes("math.js"))).toBe(true);
    expect(results.some((r) => r.includes("PASS"))).toBe(true);
    expect(
      (result.content[0] as { text: string }).text,
    ).toMatch(/Fixed add/i);
  });
});

describe("complex task: scaffold feature with checklist", () => {
  it("todo_write → multi-file write → verify → complete plan", async () => {
    const tools = new ToolRegistry();
    registerFsTools(tools);

    const model = new FakeModel([
      {
        content: [
          toolCall("t1", "todo_write", {
            todos: [
              {
                id: "scaffold",
                content: "Create package.json + src/greet.js",
                status: "in_progress",
                priority: "high",
              },
              {
                id: "verify",
                content: "Run smoke import",
                status: "pending",
                priority: "medium",
              },
              {
                id: "docs",
                content: "Write README",
                status: "pending",
                priority: "low",
              },
            ],
          }),
        ],
      },
      {
        content: [
          toolCall("t2", "write", {
            path: "package.json",
            content: JSON.stringify(
              { name: "greeter", type: "module", version: "0.0.1" },
              null,
              2,
            ),
            createDirectories: true,
          }),
          toolCall("t3", "write", {
            path: "src/greet.js",
            content:
              "export function greet(name) {\n  return `hello, ${name}`;\n}\n",
            createDirectories: true,
          }),
        ],
      },
      {
        content: [
          toolCall("t4", "todo_write", {
            todos: [
              {
                id: "scaffold",
                content: "Create package.json + src/greet.js",
                status: "completed",
              },
              {
                id: "verify",
                content: "Run smoke import",
                status: "in_progress",
              },
              {
                id: "docs",
                content: "Write README",
                status: "pending",
              },
            ],
          }),
        ],
      },
      {
        content: [
          toolCall("t5", "bash", {
            command:
              "node -e \"import('./src/greet.js').then(m => { if (m.greet('world') !== 'hello, world') process.exit(1); console.log('ok'); })\"",
          }),
        ],
      },
      {
        content: [
          toolCall("t6", "write", {
            path: "README.md",
            content: "# greeter\n\n`greet(name)` returns a greeting.\n",
          }),
        ],
      },
      {
        content: [
          toolCall("t7", "todo_write", {
            todos: [
              {
                id: "scaffold",
                content: "Create package.json + src/greet.js",
                status: "completed",
              },
              {
                id: "verify",
                content: "Run smoke import",
                status: "completed",
              },
              {
                id: "docs",
                content: "Write README",
                status: "completed",
              },
            ],
          }),
        ],
      },
      textResponse("Scaffolded greeter module, verified import, wrote README."),
    ]);

    const agent = workspaceAgent(model, tools);
    const result = await agent.run(
      "Scaffold a tiny greeter package with a checklist and verify it.",
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toBeGreaterThanOrEqual(6);

    const pkg = JSON.parse(
      await fs.readFile(path.join(tmpDir, "package.json"), "utf8"),
    ) as { name: string };
    expect(pkg.name).toBe("greeter");
    const greetSrc = await fs.readFile(
      path.join(tmpDir, "src", "greet.js"),
      "utf8",
    );
    expect(greetSrc).toContain("hello, ${name}");
    expect(await fs.readFile(path.join(tmpDir, "README.md"), "utf8")).toMatch(
      /greet\(name\)/,
    );

    const plan = agent.session.getPlanItems();
    expect(plan).toHaveLength(3);
    expect(plan.every((p) => p.status === "completed")).toBe(true);

    const results = toolResultTexts(agent);
    expect(results.some((r) => /\bok\b/.test(r))).toBe(true);
  });
});

describe("complex task: webdev UI debug + fix", () => {
  it("serve page → browser inspect → patch bug → re-check console", async () => {
    await fs.mkdir(path.join(tmpDir, "public"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "public", "index.html"),
      [
        "<!doctype html>",
        "<html><head><title>Broken Counter</title></head>",
        "<body>",
        "<h1>Counter</h1>",
        '<p id="out">0</p>',
        '<button id="inc">Submit</button>',
        "<script>",
        "  const out = document.getElementById('out');",
        "  // BUG: button id mismatch — click does nothing; also logs error",
        "  document.getElementById('missing').addEventListener('click', () => {",
        "    out.textContent = String(Number(out.textContent) + 1);",
        "  });",
        "</script>",
        "</body></html>",
        "",
      ].join("\n"),
      "utf8",
    );

    const pageState = {
      url: "about:blank",
      title: "Broken Counter",
      bodyText: "0",
      console: [] as BrowserConsoleEntry[],
    };
    pageState.console.push({
      type: "error",
      text: "Cannot read properties of null (reading 'addEventListener')",
      timestamp: Date.now(),
    });
    const page = mockSpaPage(pageState);
    setBrowserSessionManager(mockManager(page));

    const tools = new ToolRegistry();
    registerFsTools(tools);
    tools.register(browserNavigateTool);
    tools.register(browserSnapshotTool);
    tools.register(browserConsoleTool);
    tools.register(browserCloseTool);

    let server: http.Server | undefined;
    let baseUrl = "";
    await new Promise<void>((resolve, reject) => {
      server = http.createServer(async (req, res) => {
        const rel =
          req.url === "/" || !req.url
            ? "index.html"
            : req.url.replace(/^\//, "");
        try {
          const body = await fs.readFile(
            path.join(tmpDir, "public", rel),
            "utf8",
          );
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end("missing");
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("no addr"));
          return;
        }
        baseUrl = `http://127.0.0.1:${addr.port}/`;
        resolve();
      });
    });

    try {
      const model = new FakeModel([
        {
          content: [
            toolCall("t1", "browser_navigate", { url: baseUrl }),
          ],
        },
        { content: [toolCall("t2", "browser_snapshot", {})] },
        { content: [toolCall("t3", "browser_console", { errorsOnly: true })] },
        {
          content: [
            toolCall("t4", "read_file", {
              path: path.join(tmpDir, "public", "index.html"),
            }),
          ],
        },
        {
          content: [
            toolCall("t5", "apply_patch", {
              patch: `*** Begin Patch
*** Update File: public/index.html
   const out = document.getElementById('out');
-  // BUG: button id mismatch — click does nothing; also logs error
-  document.getElementById('missing').addEventListener('click', () => {
+  document.getElementById('inc').addEventListener('click', () => {
     out.textContent = String(Number(out.textContent) + 1);
   });
*** End Patch`,
            }),
          ],
        },
        {
          content: [
            toolCall("t6", "browser_navigate", { url: baseUrl }),
          ],
        },
        {
          content: [
            toolCall("t7", "bash", {
              command: `node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf8');if(!h.includes(\\"getElementById('inc')\\")) process.exit(1); console.log('selector-ok');"`,
            }),
          ],
        },
        { content: [toolCall("t8", "browser_close", {})] },
        textResponse(
          "Fixed the click handler selector (#inc) after console showed a null addEventListener error.",
        ),
      ]);

      const agent = workspaceAgent(model, tools);
      agent.setPermissionPreset("webdev");

      const result = await agent.run(
        "The counter page throws on load and the button does nothing. Debug in the browser and fix it.",
      );

      expect(result.stopReason).toBe("end_turn");
      expect(result.toolCalls).toBe(8);
      expect(pageState.url).toBe(baseUrl);

      const html = await fs.readFile(
        path.join(tmpDir, "public", "index.html"),
        "utf8",
      );
      expect(html).toContain("getElementById('inc')");
      expect(html).not.toContain("getElementById('missing')");

      const results = toolResultTexts(agent);
      expect(results.some((r) => /addEventListener|error/i.test(r))).toBe(
        true,
      );
      expect(results.some((r) => r.includes("selector-ok"))).toBe(true);
      expect(
        (result.content[0] as { text: string }).text,
      ).toMatch(/Fixed the click handler/i);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });
});

describe("complex task: delegate diagnosis then parent patches", () => {
  it("parent task → child greps bug → parent apply_patch + verify", async () => {
    await fs.mkdir(path.join(tmpDir, "lib"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "lib", "price.js"),
      [
        "export function total(unit, qty) {",
        "  return unit * qty + 1; // BUG: rogue +1",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "lib", "assert.mjs"),
      [
        "import { total } from './price.js';",
        "if (total(10, 2) !== 20) {",
        "  console.error('FAIL', total(10, 2));",
        "  process.exit(1);",
        "}",
        "console.log('PASS');",
        "",
      ].join("\n"),
      "utf8",
    );

    const childModel = new FakeModel([
      {
        content: [
          toolCall("c1", "grep", {
            pattern: "BUG",
            glob: "**/*.{js,mjs}",
          }),
        ],
      },
      {
        content: [
          toolCall("c2", "read_file", {
            path: path.join(tmpDir, "lib", "price.js"),
          }),
        ],
      },
      textResponse(
        "DIAGNOSIS: lib/price.js total() adds a rogue +1; should be unit * qty only.",
      ),
    ]);

    const submitter = new LocalMeshSubmitter({
      workerPeerId: "local",
      buildSubagent: defaultBuildSubagentFactory({
        model: childModel,
        cwd: tmpDir,
        permissionMode: "workspace-write",
      }),
    });

    let phase = 0;
    const parentModel: ModelAdapter = {
      async complete(req) {
        phase += 1;
        if (phase === 1) {
          return {
            content: [
              toolCall("p1", "task", {
                objective:
                  "Find why total(10,2) is wrong in this workspace and diagnose the bug.",
                capability_tag: "code-search",
                cost_ceiling_usd: 0.5,
                deadline_ms: 30_000,
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 2) {
          const blob = JSON.stringify(req.messages);
          expect(blob).toMatch(/DIAGNOSIS|rogue \+1|price\.js/i);
          return {
            content: [
              toolCall("p2", "apply_patch", {
                patch: `*** Begin Patch
*** Update File: lib/price.js
 export function total(unit, qty) {
-  return unit * qty + 1; // BUG: rogue +1
+  return unit * qty;
 }
*** End Patch`,
              }),
            ],
            stopReason: "tool_use",
          };
        }
        if (phase === 3) {
          return {
            content: [
              toolCall("p3", "bash", { command: "node lib/assert.mjs" }),
            ],
            stopReason: "tool_use",
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "Delegated diagnosis, removed the rogue +1, assert PASS.",
            },
          ],
          stopReason: "end_turn",
        };
      },
    };

    const tools = new ToolRegistry();
    registerFsTools(tools);
    const agent = new Agent({
      model: parentModel,
      tools,
      hooks: new HookRegistry(),
      session: new InMemorySession(newSessionId(), {
        cwd: tmpDir,
        permissionMode: "workspace-write",
        startedAt: new Date().toISOString(),
      }),
      cwd: tmpDir,
      meshSubmitter: submitter,
    });

    const result = await agent.run(
      "total(10,2) is wrong. Delegate diagnosis, then fix and verify.",
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toBe(3);

    const price = await fs.readFile(path.join(tmpDir, "lib", "price.js"), "utf8");
    expect(price).toContain("return unit * qty;");
    expect(price).not.toContain("+ 1");

    const results = toolResultTexts(agent);
    expect(results.some((r) => r.includes("PASS"))).toBe(true);
    expect(
      (result.content[0] as { text: string }).text,
    ).toMatch(/Delegated diagnosis/i);
  }, 20_000);
});

describe("complex task: multi-hunk refactor across files", () => {
  it("grep usages → dual-file apply_patch → bash regression", async () => {
    await fs.mkdir(path.join(tmpDir, "app"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "app", "config.js"),
      "export const API_URL = 'http://legacy.example';\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "client.js"),
      [
        "import { API_URL } from './config.js';",
        "export function endpoint(path) {",
        "  return API_URL + path;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "app", "smoke.mjs"),
      [
        "import { endpoint } from './client.js';",
        "import { API_URL } from './config.js';",
        "if (API_URL !== 'https://api.example') process.exit(1);",
        "if (endpoint('/v1') !== 'https://api.example/v1') process.exit(1);",
        "console.log('PASS');",
        "",
      ].join("\n"),
      "utf8",
    );

    const tools = new ToolRegistry();
    registerFsTools(tools);
    const model = new FakeModel([
      {
        content: [
          toolCall("t1", "grep", {
            pattern: "legacy\\.example|API_URL",
            glob: "app/**",
          }),
        ],
      },
      {
        content: [
          toolCall("t2", "apply_patch", {
            patch: `*** Begin Patch
*** Update File: app/config.js
-export const API_URL = 'http://legacy.example';
+export const API_URL = 'https://api.example';
*** Update File: app/client.js
 import { API_URL } from './config.js';
 export function endpoint(path) {
-  return API_URL + path;
+  return \`\${API_URL}\${path}\`;
 }
*** End Patch`,
          }),
        ],
      },
      {
        content: [
          toolCall("t3", "bash", { command: "node app/smoke.mjs" }),
        ],
      },
      textResponse(
        "Migrated API_URL to https and tightened endpoint() concatenation.",
      ),
    ]);

    const agent = workspaceAgent(model, tools);
    const result = await agent.run(
      "Replace the legacy API host and keep client.endpoint working.",
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toBe(3);

    expect(
      await fs.readFile(path.join(tmpDir, "app", "config.js"), "utf8"),
    ).toContain("https://api.example");
    expect(
      await fs.readFile(path.join(tmpDir, "app", "client.js"), "utf8"),
    ).toContain("${API_URL}${path}");

    expect(toolResultTexts(agent).some((r) => r.includes("PASS"))).toBe(true);
  });
});
