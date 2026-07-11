import type { ProviderConfig } from "../config/schema.ts";
import { BaseProvider } from "./base.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";

export class AnthropicProvider extends BaseProvider {
  private readonly url: string;
  private readonly version: string;

  constructor(cfg: ProviderConfig) {
    super(cfg);
    const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.url = `${base}/v1/messages`;
    this.version = cfg.headers?.["anthropic-version"] ?? "2023-06-01";
  }

  protected override async doComplete(
    req: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResult> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join(
      "\n\n",
    );
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": this.requireApiKey(),
      "anthropic-version": this.version,
    });
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) headers.set(k, v);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? 1024,
    };
    if (system) body.system = system;
    const temperature = req.temperature ?? this.cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.httpError(res.status, text);
    }
    const json = await res.json();
    const text = Array.isArray(json?.content)
      ? json.content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) =>
        b.text
      ).join("")
      : undefined;
    if (typeof text !== "string") {
      throw this.unexpectedShape(json);
    }
    return { text, provider: this.name, model: this.model };
  }
}
