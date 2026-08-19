/**
 * Tokenizer tests (F-fix: real argv for path validation).
 *
 * The bash tool now tokenizes the command before validation,
 * so `pathValidation` sees real operands. These tests lock the
 * tokenizer's contract: quotes stripped, escapes honored,
 * whitespace splitting.
 */

import { describe, expect, it } from "vitest";

import { tokenizeShellCommand } from "../src/permissions/bash/tokenize.js";

describe("tokenizeShellCommand", () => {
  it("splits on unquoted whitespace", () => {
    expect(tokenizeShellCommand("echo hello world")).toEqual([
      "echo",
      "hello",
      "world",
    ]);
  });

  it("keeps redirect operators as tokens", () => {
    expect(tokenizeShellCommand("echo hi > ../outside.txt")).toEqual([
      "echo",
      "hi",
      ">",
      "../outside.txt",
    ]);
  });

  it("handles no-space redirects", () => {
    expect(tokenizeShellCommand("echo hi>file")).toEqual([
      "echo",
      "hi>file",
    ]);
  });

  it("strips single quotes", () => {
    expect(tokenizeShellCommand("grep 'pattern' file")).toEqual([
      "grep",
      "pattern",
      "file",
    ]);
  });

  it("keeps apostrophes inside double quotes", () => {
    expect(tokenizeShellCommand('grep "it\'s" file')).toEqual([
      "grep",
      "it's",
      "file",
    ]);
  });

  it("keeps spaces inside double quotes", () => {
    expect(tokenizeShellCommand('cat "my file.txt"')).toEqual([
      "cat",
      "my file.txt",
    ]);
  });

  it("honors backslash escapes outside quotes", () => {
    expect(tokenizeShellCommand('echo a\\"b')).toEqual(["echo", 'a"b']);
  });

  it("treats an escaped space as part of the word", () => {
    expect(tokenizeShellCommand("echo foo\\ bar")).toEqual(["echo", "foo bar"]);
  });

  it("returns [] for an empty command", () => {
    expect(tokenizeShellCommand("")).toEqual([]);
    expect(tokenizeShellCommand("   ")).toEqual([]);
  });

  it("keeps tilde and variable-prefixed paths intact", () => {
    expect(tokenizeShellCommand("rm -rf ~/secrets/key")).toEqual([
      "rm",
      "-rf",
      "~/secrets/key",
    ]);
    expect(tokenizeShellCommand("cat $HOME/x")).toEqual(["cat", "$HOME/x"]);
  });
});
