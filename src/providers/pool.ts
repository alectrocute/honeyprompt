import type { PoolConfig } from "../config/schema.ts";
import type { Logger } from "../observability/logger.ts";
import { shuffle, weightedOrder } from "../util/random.ts";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  ProviderError,
} from "./types.ts";

/**
 * Fronts a set of providers with a selection strategy plus automatic failover.
 * Every strategy still falls over to the remaining providers when the chosen
 * one errors, so a single dead backend never takes the honeypot down.
 */
export class ProviderPool {
  private readonly providers: Provider[];
  private rrIndex = 0;

  constructor(
    providers: Provider[],
    private readonly cfg: PoolConfig,
    private readonly logger: Logger,
  ) {
    this.providers = providers;
    if (providers.length === 0) throw new Error("provider pool created with no providers");
  }

  get size(): number {
    return this.providers.length;
  }

  names(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** Returns providers ordered by the configured strategy for this request. */
  private order(): Provider[] {
    switch (this.cfg.strategy) {
      case "failover":
        return [...this.providers];
      case "random":
        return shuffle([...this.providers]);
      case "weighted":
        return weightedOrder(this.providers, (p) => p.weight);
      case "round-robin": {
        const start = this.rrIndex % this.providers.length;
        this.rrIndex = (this.rrIndex + 1) % this.providers.length;
        return [...this.providers.slice(start), ...this.providers.slice(0, start)];
      }
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const ordered = this.order();
    let lastError: unknown;
    for (const provider of ordered) {
      try {
        return await provider.complete(req);
      } catch (error) {
        lastError = error;
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        const retryable = !(error instanceof ProviderError) || error.retryable;
        this.logger.warn("provider failed, trying next", {
          provider: provider.name,
          retryable,
          error: (error as Error).message,
        });
        if (!retryable) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all providers in the pool failed");
  }
}

export function buildPool(
  providersByName: Map<string, Provider>,
  cfg: PoolConfig,
  logger: Logger,
): ProviderPool | undefined {
  if (providersByName.size === 0) return undefined;
  const ordered: Provider[] = cfg.order.length > 0
    ? cfg.order.map((n) => providersByName.get(n)!).filter(Boolean)
    : [...providersByName.values()];
  return new ProviderPool(ordered, cfg, logger);
}
