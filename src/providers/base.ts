import type { ProviderConfig } from "../config/schema.ts";
import { TokenBucket } from "../util/ratelimit.ts";
import { withRetry } from "../util/retry.ts";
import { truncate } from "../util/text.ts";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  ProviderError,
} from "./types.ts";

/**
 * Shared machinery for every provider: per-provider rate limiting, request
 * timeout, and retry with exponential backoff. Concrete providers only
 * implement `doComplete`, which performs a single attempt.
 */
export abstract class BaseProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly weight: number;
  protected readonly cfg: ProviderConfig;
  private readonly bucket?: TokenBucket;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.model = cfg.model;
    this.weight = cfg.weight;
    if (cfg.rateLimit && cfg.rateLimit.rps > 0) {
      this.bucket = new TokenBucket(cfg.rateLimit.rps, Math.max(1, cfg.rateLimit.burst));
    }
  }

  protected abstract doComplete(
    req: CompletionRequest,
    signal: AbortSignal,
  ): Promise<CompletionResult>;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    await this.bucket?.acquire(req.signal);
    return await withRetry(() => this.attempt(req), {
      retries: this.cfg.retries,
      signal: req.signal,
      shouldRetry: (e) => e instanceof ProviderError && e.retryable,
    });
  }

  private async attempt(req: CompletionRequest): Promise<CompletionResult> {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), this.cfg.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timer.signal]) : timer.signal;
    try {
      return await this.doComplete({ ...req, signal }, signal);
    } catch (err) {
      if (timer.signal.aborted && !(req.signal?.aborted)) {
        throw new ProviderError(
          `provider "${this.name}" timed out after ${this.cfg.timeoutMs}ms`,
          this.name,
          true,
        );
      }
      if (err instanceof ProviderError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ProviderError(
        `provider "${this.name}" request failed: ${(err as Error).message}`,
        this.name,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  protected apiKey(): string | undefined {
    if (!this.cfg.apiKeyEnv) return undefined;
    return Deno.env.get(this.cfg.apiKeyEnv);
  }

  protected requireApiKey(): string {
    const key = this.apiKey();
    if (!key) {
      throw new ProviderError(
        `provider "${this.name}" is missing API key (env ${this.cfg.apiKeyEnv ?? "?"})`,
        this.name,
        false,
      );
    }
    return key;
  }

  /** Classifies an HTTP status into a ProviderError with a retryable flag. */
  protected httpError(status: number, body: string): ProviderError {
    const retryable = status === 408 || status === 429 || status >= 500;
    return new ProviderError(
      `provider "${this.name}" HTTP ${status}: ${truncate(body, 200)}`,
      this.name,
      retryable,
      status,
    );
  }

  /** Raised when a provider returns a 2xx body that doesn't match the expected shape. */
  protected unexpectedShape(json: unknown): ProviderError {
    return new ProviderError(
      `provider "${this.name}" returned an unexpected response: ${
        truncate(JSON.stringify(json), 200)
      }`,
      this.name,
      false,
    );
  }
}
