import type { Logger } from "../observability/logger.ts";
import { METRICS } from "../observability/metric-defs.ts";
import type { Metrics } from "../observability/metrics.ts";
import { withRetry } from "../util/retry.ts";
import type { HttpBatchOptions, Sink, SinkEnvelope } from "./types.ts";

export class SinkHttpError extends Error {
  override name = "SinkHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Shared async queue + batch flusher for HTTP sinks. Subclasses only implement
 * `sendBatch`. `write` is synchronous from the caller's perspective and never
 * throws into the event bus.
 */
export abstract class HttpBatchSink implements Sink {
  abstract readonly name: string;
  private readonly queue: SinkEnvelope[] = [];
  private readonly opts: HttpBatchOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private dropWarned = false;

  constructor(
    opts: HttpBatchOptions,
    protected readonly logger: Logger,
    protected readonly metrics?: Metrics,
  ) {
    this.opts = opts;
    if (opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, opts.flushIntervalMs);
      // Don't keep the process alive solely for sink flushing.
      Deno.unrefTimer(this.timer);
    }
  }

  protected abstract sendBatch(batch: SinkEnvelope[], signal: AbortSignal): Promise<void>;

  write(event: SinkEnvelope): void {
    if (this.closed) return;
    if (this.queue.length >= this.opts.queueCapacity) {
      this.metrics?.count(METRICS.sinkDropped, { sink: this.name });
      if (!this.dropWarned) {
        this.dropWarned = true;
        this.logger.warn("sink queue full; dropping events", {
          sink: this.name,
          capacity: this.opts.queueCapacity,
        });
      }
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= this.opts.batchSize) void this.flush();
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.drain());
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.opts.batchSize);
      try {
        await withRetry(() => this.attempt(batch), {
          retries: this.opts.retries,
          shouldRetry: (e) => e instanceof SinkHttpError && e.retryable,
          onRetry: (attempt, error, delayMs) => {
            this.logger.warn("sink delivery retry", {
              sink: this.name,
              attempt,
              delayMs: Math.round(delayMs),
              error: (error as Error).message,
            });
          },
        });
        this.metrics?.count(METRICS.sinkEvents, { sink: this.name, result: "ok" }, batch.length);
      } catch (error) {
        this.metrics?.count(
          METRICS.sinkEvents,
          { sink: this.name, result: "error" },
          batch.length,
        );
        this.logger.error("sink delivery failed", {
          sink: this.name,
          count: batch.length,
          error: (error as Error).message,
        });
      }
    }
  }

  private async attempt(batch: SinkEnvelope[]): Promise<void> {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), this.opts.timeoutMs);
    try {
      await this.sendBatch(batch, timer.signal);
    } catch (err) {
      if (timer.signal.aborted) {
        throw new SinkHttpError(
          `sink "${this.name}" timed out after ${this.opts.timeoutMs}ms`,
          0,
          true,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Classifies an HTTP status into a retryable sink error. */
export function sinkHttpError(sink: string, status: number, body: string): SinkHttpError {
  const retryable = status === 408 || status === 429 || status >= 500;
  const snippet = body.length > 200 ? body.slice(0, 200) : body;
  return new SinkHttpError(
    `sink "${sink}" HTTP ${status}${snippet ? `: ${snippet}` : ""}`,
    status,
    retryable,
  );
}
