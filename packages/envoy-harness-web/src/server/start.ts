/**
 * Local HTTP + WebSocket host for the envoy-harness WebUI.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { attachAcpWsBridge } from "./acp-ws-bridge.js";
import { resolveHarnessAcpCommand } from "./spawn.js";

export interface StartWebServerOptions {
  port?: number;
  host?: string;
  cwd?: string;
  /** Extra argv for `envoy-harness --acp` (provider, model, peers, …). */
  harnessArgs?: string[];
  /** Use Vite middleware mode. Default: true when dist/client is missing. */
  dev?: boolean;
  openBrowser?: boolean;
  stderr?: NodeJS.WritableStream;
}

export interface WebServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function clientDistDir(): string {
  return path.join(packageRoot(), "dist/client");
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".html") return "text/html";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

export async function startWebServer(
  options: StartWebServerOptions = {},
): Promise<WebServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 5177;
  const cwd = options.cwd ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;
  const harnessArgs = options.harnessArgs ?? [];
  const dist = clientDistDir();
  const useDev =
    options.dev === true ||
    (options.dev !== false && !fs.existsSync(path.join(dist, "index.html")));

  let vite: ViteDevServer | undefined;
  if (useDev) {
    vite = await createViteServer({
      root: packageRoot(),
      server: { middlewareMode: true },
      appType: "custom",
      configFile: path.join(packageRoot(), "vite.config.ts"),
    });
  }

  const writeHealth = (res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "envoy-harness-web",
        acp: "ws",
      }),
    );
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/health" || url.startsWith("/api/health?")) {
      writeHealth(res);
      return;
    }

    if (vite !== undefined) {
      vite.middlewares(req, res, () => {
        void (async () => {
          try {
            const templatePath = path.join(packageRoot(), "index.html");
            let html = await fs.promises.readFile(templatePath, "utf8");
            html = await vite!.transformIndexHtml(url, html);
            res.writeHead(200, { "content-type": "text/html" });
            res.end(html);
          } catch (err) {
            vite!.ssrFixStacktrace(err as Error);
            res.writeHead(500);
            res.end(String(err));
          }
        })();
      });
      return;
    }

    const rel =
      url === "/" || url === ""
        ? "index.html"
        : (url.split("?")[0] ?? "/").replace(/^\//, "");
    const filePath = path.normalize(path.join(dist, rel));
    if (!filePath.startsWith(dist)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        fs.readFile(path.join(dist, "index.html"), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end("not found — run pnpm build in envoy-harness-web");
            return;
          }
          res.writeHead(200, { "content-type": "text/html" });
          res.end(html);
        });
        return;
      }
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws/acp")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const resolved = resolveHarnessAcpCommand(harnessArgs);
      stderr.write(
        `envoy-harness-web: spawning ${resolved.command} ${resolved.args.join(" ")}\n`,
      );
      attachAcpWsBridge({
        command: resolved.command,
        args: resolved.args,
        cwd,
        ws,
        onChildStderr: (chunk) => {
          stderr.write(chunk);
        },
        onChildExit: (code, signal) => {
          stderr.write(
            `envoy-harness-web: acp child exited code=${code} signal=${signal}\n`,
          );
        },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const url = `http://${host}:${port}/`;
  stderr.write(`envoy-harness-web: listening on ${url}\n`);

  if (options.openBrowser) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args =
      process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
  }

  return {
    port,
    url,
    async close() {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await vite?.close();
    },
  };
}
