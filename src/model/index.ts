import { AnthropicProvider } from "./anthropic.js";
import { FixtureProvider } from "./fixture.js";
import type { ModelProvider } from "./provider.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Provider selection. The fixture provider is the default, even when an API key is
 * present in the environment: the live provider needs an explicit opt-in
 * (MODEL_PROVIDER=anthropic) AND a key, so nothing ever spends money by accident.
 */
export function selectProvider(env: Record<string, string | undefined> = process.env): ModelProvider {
  const choice = (env.MODEL_PROVIDER ?? "fixture").toLowerCase();
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  if (choice === "fixture") return new FixtureProvider({ model });
  if (choice === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return new AnthropicProvider({ apiKey, model });
  }
  throw new Error(`Unknown MODEL_PROVIDER '${choice}' (expected 'fixture' or 'anthropic')`);
}
