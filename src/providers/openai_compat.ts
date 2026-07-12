import type { ProviderConfig } from "../config/schema.ts";
import { NAME, REPO_URL } from "../meta.ts";
import { BaseProvider } from "./base.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";

const DEFAULT_BASE_URLS: Partial<Record<ProviderConfig["type"], string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  llamacpp: "http://localhost:8080/v1",
};

/**
 * Covers every provider that speaks the OpenAI Chat Completions wire format:
 * OpenAI itself, Azure OpenAI, OpenRouter, Ollama, llama.cpp, and any other
 * OpenAI-compatible endpoint.
 */
export class OpenAICompatibleProvider extends BaseProvider {
  private readonly url: string;
  private readonly keyRequired: boolean;

  constructor(cfg: ProviderConfig) {
    super(cfg);
    this.keyRequired = cfg.type === "openai" || cfg.type === "azure" ||
      cfg.type === "openrouter";
    this.url = this.resolveUrl(cfg);
  }

  private resolveUrl(cfg: ProviderConfig): string {
    if (cfg.type === "azure") {
      const base = cfg.baseUrl?.replace(/\/$/, "");
      if (!base || !cfg.azure) {
        throw new Error(`azure provider "${cfg.name}" needs baseUrl and azure.deployment`);
      }
      return `${base}/openai/deployments/${cfg.azure.deployment}/chat/completions` +
        `?api-version=${cfg.azure.apiVersion}`;
    }
    const base = (cfg.baseUrl ?? DEFAULT_BASE_URLS[cfg.type] ?? "").replace(/\/$/, "");
    return `${base}/chat/completions`;
  }

  private buildHeaders(): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    const key = this.keyRequired ? this.requireApiKey() : this.apiKey();
    if (key) {
      if (this.cfg.type === "azure") headers.set("api-key", key);
      else headers.set("authorization", `Bearer ${key}`);
    }
    if (this.cfg.type === "openrouter") {
      headers.set("http-referer", REPO_URL);
      headers.set("x-title", NAME);
    }
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) headers.set(k, v);
    return headers;
  }

  protected override async doComplete(
    req: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      stream: false,
    };
    const temperature = req.temperature ?? this.cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = req.maxTokens ?? this.cfg.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const res = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.httpError(res.status, text);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw this.unexpectedShape(json);
    }
    // Prefer the model the API reports it actually used: for routing models
    // like openrouter/free, that's the concrete model behind this response.
    const model = typeof json?.model === "string" && json.model ? json.model : this.model;
    return { text, provider: this.name, model };
  }
}
