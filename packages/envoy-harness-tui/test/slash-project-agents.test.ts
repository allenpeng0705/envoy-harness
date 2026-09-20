/**
 * `/project` and `/agents` slash parsing (hermetic, no client).
 */

import { describe, expect, it } from "vitest";

import { matchingSlashCommands, parseSlash } from "../src/slash.js";

describe("parseSlash — /project", () => {
  it("defaults to list", () => {
    expect(parseSlash("/project")).toEqual({ kind: "project", action: "list" });
    expect(parseSlash("/project list")).toEqual({
      kind: "project",
      action: "list",
    });
  });

  it("parses add with an absolute path and a multi-word name", () => {
    expect(parseSlash("/project add /abs/path")).toEqual({
      kind: "project",
      action: "add",
      target: "/abs/path",
    });
    expect(parseSlash("/project add /abs/path My Name")).toEqual({
      kind: "project",
      action: "add",
      target: "/abs/path",
      name: "My Name",
    });
  });

  it("parses remove and open (index or path)", () => {
    expect(parseSlash("/project remove /abs/path")).toEqual({
      kind: "project",
      action: "remove",
      target: "/abs/path",
    });
    expect(parseSlash("/project open 2")).toEqual({
      kind: "project",
      action: "open",
      target: "2",
    });
    expect(parseSlash("/project open /abs/path")).toEqual({
      kind: "project",
      action: "open",
      target: "/abs/path",
    });
  });

  it("rejects a missing argument and an unknown subcommand", () => {
    expect(parseSlash("/project add")?.kind).toBe("unknown");
    expect(parseSlash("/project remove")?.kind).toBe("unknown");
    expect(parseSlash("/project open")?.kind).toBe("unknown");
    expect(parseSlash("/project bogus")?.kind).toBe("unknown");
  });
});

describe("parseSlash — /agents", () => {
  it("defaults to list", () => {
    expect(parseSlash("/agents")).toEqual({ kind: "agents", action: "list" });
    expect(parseSlash("/agents list")).toEqual({
      kind: "agents",
      action: "list",
    });
  });

  it("parses send with a message containing spaces", () => {
    expect(parseSlash("/agents send abc123 hello there world")).toEqual({
      kind: "agents",
      action: "send",
      id: "abc123",
      message: "hello there world",
    });
  });

  it("parses interrupt with and without a reason", () => {
    expect(parseSlash("/agents interrupt abc123")).toEqual({
      kind: "agents",
      action: "interrupt",
      id: "abc123",
    });
    expect(parseSlash("/agents interrupt abc123 stop now")).toEqual({
      kind: "agents",
      action: "interrupt",
      id: "abc123",
      reason: "stop now",
    });
  });

  it("rejects incomplete control commands", () => {
    expect(parseSlash("/agents send abc123")?.kind).toBe("unknown");
    expect(parseSlash("/agents send")?.kind).toBe("unknown");
    expect(parseSlash("/agents interrupt")?.kind).toBe("unknown");
    expect(parseSlash("/agents bogus")?.kind).toBe("unknown");
  });
});

describe("SLASH_COMMANDS palette", () => {
  it("completes /project and /agents", () => {
    expect(matchingSlashCommands("/pro")).toContain("/project");
    expect(matchingSlashCommands("/age")).toContain("/agents");
  });
});
