/**
 * Phase C — wire jobs / web / terminal / credentials into
 * a tool registry.
 *
 * Kept out of `Agent` so Phase B plugin work and Phase C
 * environment seams don't collide. CLI hosts call this once
 * after registering `BUILTIN_TOOLS`.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { CredentialsProvider } from "../credentials/types.js";
import {
  createAskCredentialsProvider,
  createCredentialsProvider,
  createEnvCredentialsProvider,
  createFileCredentialsProvider,
  CredentialError,
} from "../credentials/index.js";
import type { UserQuestionService } from "../interaction/user-questions.js";
import {
  createLocalJobRegistry,
  registerJobTools,
  type JobRegistry,
} from "../jobs/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { makeBashTool } from "../tools/builtin/bash.js";
import {
  createFakeTerminalBackend,
  createTerminalSessionService,
  registerTerminalTools,
  type TerminalSessionService,
} from "../terminal/index.js";
import {
  createPtyTerminalBackend,
  isPtyAvailable,
} from "../terminal/pty-backend.js";
import {
  createFilesystemSkillProvider,
  createSkillRegistry,
  registerSkillTools,
  type SkillRegistry,
} from "../skills/index.js";
import {
  createHttpFetchProvider,
  createWebRuntime,
  registerWebTools,
  type WebRuntime,
} from "../web/index.js";
import { createBraveSearchProvider } from "../web/search-brave.js";

const DEFAULT_CREDENTIAL_NAMES = ["BRAVE_SEARCH_API_KEY"] as const;

export interface WireEnvironmentOptions {
  /** Pre-built credentials; otherwise env + optional file + ask. */
  credentials?: CredentialsProvider & {
    resolveByName?(
      name: string,
      opts: { signal: AbortSignal },
    ): Promise<string>;
    revealedValues?(): ReadonlySet<string>;
  };
  /** When set, ask-backend can prompt for missing secrets. */
  questions?: UserQuestionService;
  /**
   * Prefer the real `node-pty` backend when the optional
   * dependency resolves. Default `true`.
   */
  preferPty?: boolean;
  /** Override default credentials file path (tests). */
  credentialsFilePath?: string;
  /**
   * Register the SKILL.md model-facing tools (`skill`,
   * `skill_list`) on the supplied tool registry. Default
   * `true`. Set `false` for hosts that want to manage their
   * own skill surface (or for hermetic tests that should
   * not see filesystem-backed skills).
   */
  enableSkills?: boolean;
}

export interface EnvironmentCapabilities {
  jobs: JobRegistry;
  web: WebRuntime;
  terminals: TerminalSessionService;
  /** SKILL.md registry (filesystem provider wired). */
  skills: SkillRegistry;
  credentials: CredentialsProvider & {
    resolveByName?(
      name: string,
      opts: { signal: AbortSignal },
    ): Promise<string>;
    revealedValues?(): ReadonlySet<string>;
  };
  /** Cancel jobs + close terminals. Safe to call more than once. */
  dispose(): Promise<void>;
}

function defaultCredentialsFilePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "envoy-harness",
    "credentials.json",
  );
}

/**
 * Build the default credentials cascade: env → optional
 * `~/.config/envoy-harness/credentials.json` → ask (when
 * `questions` is provided).
 */
export function createDefaultCredentials(options: {
  questions?: UserQuestionService;
  filePath?: string;
}): CredentialsProvider & {
  resolveByName(
    name: string,
    opts: { signal: AbortSignal },
  ): Promise<string>;
  revealedValues(): ReadonlySet<string>;
} {
  const env = createEnvCredentialsProvider({
    knownNames: DEFAULT_CREDENTIAL_NAMES,
  });
  const file = createFileCredentialsProvider({
    filePath: options.filePath ?? defaultCredentialsFilePath(),
  });
  const ask =
    options.questions !== undefined
      ? createAskCredentialsProvider({
          questions: options.questions,
          knownNames: [...DEFAULT_CREDENTIAL_NAMES],
        })
      : {
          async resolve(): Promise<string> {
            throw new CredentialError(
              "ask credentials require a UserQuestionService",
              "NOT_FOUND",
            );
          },
          list: () => [],
        };

  return createCredentialsProvider({ env, file, ask });
}

/**
 * Create registries, register model-facing tools, return
 * handles for disposal. Web ships with the keyless HTTP
 * fetch provider; Brave search registers when
 * `BRAVE_SEARCH_API_KEY` is present in the environment.
 * Terminal prefers `node-pty` when loadable.
 */
export function wireEnvironmentTools(
  tools: ToolRegistry,
  options: WireEnvironmentOptions = {},
): EnvironmentCapabilities {
  const credentials =
    options.credentials ??
    createDefaultCredentials({
      ...(options.questions !== undefined
        ? { questions: options.questions }
        : {}),
      ...(options.credentialsFilePath !== undefined
        ? { filePath: options.credentialsFilePath }
        : {}),
    });

  const jobs = createLocalJobRegistry();
  registerJobTools(tools, jobs);

  // bash --job sugar: re-register bash bound to the job registry.
  tools.unregister("bash");
  tools.register(makeBashTool({ jobs }));

  const web = createWebRuntime();
  web.registerFetchProvider(createHttpFetchProvider());
  const brave = createBraveSearchProvider({ credentials });
  // Cheap gate: only register when env advertises the key
  // (matches available()'s primary check). Tests can pass
  // credentials that already list the name to force registration.
  if (brave.available()) {
    web.registerSearchProvider(brave);
  }
  registerWebTools(tools, web);

  const terminals = createTerminalSessionService();
  const preferPty = options.preferPty !== false;
  if (preferPty && isPtyAvailable()) {
    terminals.registerBackend(createPtyTerminalBackend());
  } else {
    terminals.registerBackend(createFakeTerminalBackend());
  }
  registerTerminalTools(tools, terminals, jobs);

  // SKILL.md loader (L0 reuse): project + user roots, codex /
  // deepseek / universal. Hosts can disable by passing
  // `enableSkills: false` in WireEnvironmentOptions.
  const skills: SkillRegistry = createSkillRegistry();
  skills.registerProvider(
    createFilesystemSkillProvider({ homeDir: os.homedir() }),
  );
  if (options.enableSkills !== false) {
    registerSkillTools(tools, skills);
  }

  let disposed = false;
  return {
    jobs,
    web,
    terminals,
    credentials,
    skills,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all([jobs.dispose(), terminals.dispose()]);
    },
  };
}
