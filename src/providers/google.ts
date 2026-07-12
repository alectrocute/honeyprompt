import type { ProviderConfig } from "../config/schema.ts";
import { BaseProvider } from "./base.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";

/** Google Gemini via the Generative Language API (generateContent). */
export class GoogleProvider extends BaseProvider {
  private readonly base: string;

  constructor(cfg: ProviderConfig) {
    super(cfg);
    this.base = (cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/$/,
      "",
    );
  }

  protected override async doComplete(
    req: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResult> {
    const key = this.requireApiKey();
    const url = `${this.base}/models/${this.model}:generateContent`;

    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join(
      "\n\n",
    );
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    const temperature = req.temperature ?? this.cfg.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;
    const maxTokens = req.maxTokens ?? this.cfg.maxTokens;
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    const headers = new Headers({ "content-type": "application/json", "x-goog-api-key": key });
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) headers.set(k, v);

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.httpError(res.status, text);
    }
    const json = await res.json();
    const parts = json?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.map((p: { text?: string }) => p.text ?? "").join("")
      : undefined;
    if (typeof text !== "string") {
      throw this.unexpectedShape(json);
    }
    // modelVersion reports the exact version that generated this response.
    const model = typeof json?.modelVersion === "string" && json.modelVersion
      ? json.modelVersion
      : this.model;
    return { text, provider: this.name, model };
  }
}
