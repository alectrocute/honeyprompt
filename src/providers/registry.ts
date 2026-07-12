import type { ProviderConfig } from "../config/schema.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GoogleProvider } from "./google.ts";
import { OpenAICompatibleProvider } from "./openai_compat.ts";
import type { Provider } from "./types.ts";

export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.type) {
    case "openai":
    case "openai-compatible":
    case "azure":
    case "openrouter":
    case "ollama":
    case "llamacpp":
      return new OpenAICompatibleProvider(cfg);
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "google":
      return new GoogleProvider(cfg);
  }
}

export function createProviders(cfgs: ProviderConfig[]): Map<string, Provider> {
  const map = new Map<string, Provider>();
  for (const cfg of cfgs) map.set(cfg.name, createProvider(cfg));
  return map;
}
