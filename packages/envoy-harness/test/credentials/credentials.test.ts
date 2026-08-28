/**
 * Phase C / Item 13 — credentials tests (hermetic).
 */

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAskCredentialsProvider,
  createCredentialsProvider,
  createEnvCredentialsProvider,
  createFileCredentialsProvider,
  createRedactingTracer,
  CredentialError,
} from "../../src/credentials/index.js";
import { createUserQuestionService } from "../../src/interaction/user-questions.js";
import type { TraceEvent, Tracer } from "../../src/trace/types.js";

describe("credentials", () => {
  it("resolves from env", async () => {
    const env = createEnvCredentialsProvider({
      env: { MY_KEY: "secret-env" },
    });
    const value = await env.resolve(
      { name: "MY_KEY", source: "env" },
      { signal: AbortSignal.timeout(5_000) },
    );
    expect(value).toBe("secret-env");
  });

  it("resolves from a 0600 JSON file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "creds-"));
    const filePath = path.join(dir, "creds.json");
    await writeFile(filePath, JSON.stringify({ FILE_KEY: "secret-file" }));
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    const file = createFileCredentialsProvider({
      filePath,
      skipPermissionCheck: process.platform === "win32",
    });
    const value = await file.resolve(
      { name: "FILE_KEY", source: "file" },
      { signal: AbortSignal.timeout(5_000) },
    );
    expect(value).toBe("secret-file");
  });

  it("rejects world-readable credentials files", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(tmpdir(), "creds-"));
    const filePath = path.join(dir, "creds.json");
    await writeFile(filePath, JSON.stringify({ K: "v" }));
    await chmod(filePath, 0o644);
    const file = createFileCredentialsProvider({ filePath });
    await expect(
      file.resolve(
        { name: "K", source: "file" },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("ask provider returns CANCELLED when no user channel", async () => {
    const questions = createUserQuestionService();
    const ask = createAskCredentialsProvider({ questions });
    await expect(
      ask.resolve(
        { name: "X", source: "ask" },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("composite resolveByName cascades env → file → ask", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "creds-"));
    const filePath = path.join(dir, "creds.json");
    await writeFile(filePath, JSON.stringify({ ONLY_FILE: "from-file" }));
    if (process.platform !== "win32") await chmod(filePath, 0o600);

    const creds = createCredentialsProvider({
      env: createEnvCredentialsProvider({ env: { ONLY_ENV: "from-env" } }),
      file: createFileCredentialsProvider({
        filePath,
        skipPermissionCheck: process.platform === "win32",
      }),
      ask: createAskCredentialsProvider({
        questions: createUserQuestionService(),
      }),
    });

    expect(
      await creds.resolveByName("ONLY_ENV", {
        signal: AbortSignal.timeout(5_000),
      }),
    ).toBe("from-env");
    expect(
      await creds.resolveByName("ONLY_FILE", {
        signal: AbortSignal.timeout(5_000),
      }),
    ).toBe("from-file");
    await expect(
      creds.resolveByName("MISSING", {
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeInstanceOf(CredentialError);
  });

  it("rejects mesh source in Package 1", async () => {
    const creds = createCredentialsProvider({
      env: createEnvCredentialsProvider({ env: {} }),
      file: createFileCredentialsProvider({
        filePath: "/dev/null",
        skipPermissionCheck: true,
      }),
      ask: createAskCredentialsProvider({
        questions: createUserQuestionService(),
      }),
    });
    await expect(
      creds.resolve(
        { name: "X", source: "mesh" },
        { signal: AbortSignal.timeout(5_000) },
      ),
    ).rejects.toMatchObject({ code: "MESH_FORBIDDEN" });
  });

  it("redacting tracer scrubs revealed secrets", () => {
    const events: TraceEvent[] = [];
    const inner: Tracer = { emit: (e) => events.push(e) };
    const secrets = new Set(["super-secret-token"]);
    const tracer = createRedactingTracer(inner, {
      secrets: () => secrets,
      secretNames: () => new Map([["super-secret-token", "API_KEY"]]),
    });
    tracer.emit({
      kind: "error",
      ts: new Date().toISOString(),
      iteration: 0,
      message: "token=super-secret-token",
    });
    const payload = JSON.stringify(events[0]);
    expect(payload).not.toContain("super-secret-token");
    expect(payload).toContain("[REDACTED:API_KEY]");
  });
});
