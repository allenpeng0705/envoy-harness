/**
 * Provider dispatch + LLM-related re-exports (F7.5).
 *
 * **What this module does:**
 * - Re-exports the three adapters (`OpenAIAdapter`,
 *   `AnthropicAdapter`, `DeepSeekAdapter`) and the
 *   `HttpClient` / `FetchHttpClient` / `FakeHttpClient`
 *   primitives.
 * - Exports `createProviderAdapter`, the helper that
 *   resolves a `--provider <name>` + env vars to a
 *   concrete adapter. The CLI uses this when no model
 *   is injected via `RunOptions.model`.
 *
 * **Why one file for the dispatch helper?** the
 * alternative is putting it in each adapter file, which
 * creates a circular import (openai.ts → deepseek.ts →
 * openai.ts for the `ollama` case). A single dispatcher
 * imports all three and is the only place that knows the
 * provider-name → adapter-class mapping.
 *
 * **Adding a new provider:** add a `case` to the switch,
 * document the env var, add tests. The CLI flag is
 * already accepted as any string.
 *
 * **Stability:** `createProviderAdapter` and
 * `ProviderConfig` are the public surface. Additive; new
 * providers don't break existing callers.
 */

import { AnthropicAdapter } from "./anthropic.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { OpenAIAdapter } from "./openai.js";
import type { ModelAdapter } from "../model.js";

export {
  AnthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicToolDefinition,
  is2xx as isAnthropic2xx,
  messagesToAnthropic,
  parseError as parseAnthropicError,
  parseMessagesResponse,
  splitSystemAndMessages,
  toolsToAnthropic,
} from "./anthropic.js";

export {
  DeepSeekAdapter,
  type DeepSeekAdapterOptions,
} from "./deepseek.js";

export {
  FakeHttpClient,
  FetchHttpClient,
  messagesToOpenAI,
  toolsToOpenAI,
  zodToJsonSchema,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type OpenAIMessage,
  type OpenAIToolCall,
  type OpenAIToolDefinition,
} from "./http.js";

export {
  is2xx as isOpenAI2xx,
  OpenAIAdapter,
  type OpenAIAdapterOptions,
  parseChatResponse,
  parseError as parseOpenAIError,
} from "./openai.js";

export type { CompleteInput, ModelAdapter, ModelResponse } from "../model.js";

// ---------------------------------------------------------------------------
// createProviderAdapter — the CLI dispatch helper
// ---------------------------------------------------------------------------

/** Config for `createProviderAdapter`. */
export interface ProviderConfig {
  /**
   * The provider name. One of: `"openai"`, `"anthropic"`,
   * `"deepseek"`, `"ollama"`. Case-insensitive.
   */
  provider: string;
  /**
   * Optional model identifier. When omitted, the provider's
   * default model is used (`gpt-4o`, `claude-sonnet-4-6`,
   * `deepseek-chat`, `llama3.1`).
   */
  model?: string;
  /**
   * The environment to read API keys from. Default: `process.env`.
   * Override for tests.
   */
  env?: NodeJS.ProcessEnv;
}

/** Default models per provider. Public so callers can show them in help text. */
export const DEFAULT_PROVIDER_MODELS: Readonly<Record<string, string>> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-6",
  deepseek: "deepseek-chat",
  ollama: "llama3.1",
};

/** The list of supported provider names. Public so the CLI can validate. */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "deepseek",
  "ollama",
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Build a `ModelAdapter` for the given provider, reading
 * the API key from the environment.
 *
 * **Errors:** throws `Error` (caught and wrapped as
 * `CliError(EXIT_USAGE)` by the runner) when:
 * - the provider name is unknown,
 * - the provider requires an API key env var (`OPENAI_API_KEY`,
 *   `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`) and it is not set.
 *
 * **`ollama` is keyless:** it uses the OpenAI-compatible
 * endpoint at `http://localhost:11434/v1` (override via
 * `OLLAMA_BASE_URL`). A placeholder API key (`"ollama"`)
 * is passed because `OpenAIAdapter` requires a non-empty
 * key, but the request is unauthenticated.
 */
export function createProviderAdapter(config: ProviderConfig): ModelAdapter {
  const env = config.env ?? process.env;
  const provider = config.provider.toLowerCase();

  switch (provider) {
    case "openai": {
      const apiKey = requireEnv(env, "OPENAI_API_KEY");
      return new OpenAIAdapter({
        apiKey,
        model: config.model ?? DEFAULT_PROVIDER_MODELS["openai"]!,
      });
    }
    case "anthropic": {
      const apiKey = requireEnv(env, "ANTHROPIC_API_KEY");
      return new AnthropicAdapter({
        apiKey,
        model: config.model ?? DEFAULT_PROVIDER_MODELS["anthropic"]!,
      });
    }
    case "deepseek": {
      const apiKey = requireEnv(env, "DEEPSEEK_API_KEY");
      return new DeepSeekAdapter({
        apiKey,
        ...(config.model !== undefined ? { model: config.model } : {}),
      });
    }
    case "ollama": {
      // Ollama exposes an OpenAI-compatible endpoint at /v1.
      // No auth required. The OpenAIAdapter requires a non-empty
      // key, so we pass a placeholder.
      return new OpenAIAdapter({
        apiKey: "ollama",
        model: config.model ?? DEFAULT_PROVIDER_MODELS["ollama"]!,
        baseUrl: env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
      });
    }
    default: {
      const known = SUPPORTED_PROVIDERS.join(", ");
      throw new Error(
        `unknown provider: ${config.provider} (expected one of: ${known})`,
      );
    }
  }
}

/** Read a required env var; throw a clear error if missing. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--provider requires ${name} env var to be set`);
  }
  return value;
}
