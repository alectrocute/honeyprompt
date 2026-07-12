import type { DeceptionEvent } from "../observability/events.ts";

/**
 * A durable or remote destination for deception events. `write` must never throw
 * into the event bus — sinks queue/fail internally and surface problems via logs
 * and metrics.
 */
export interface Sink {
  readonly name: string;
  write(event: SinkEnvelope): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Event shape handed to sinks after optional redaction and address normalization.
 * Remote adapters may add vendor-specific wrappers on top of this envelope.
 */
export type SinkEnvelope = DeceptionEvent & {
  srcIp?: string;
  srcPort?: number;
};

/** Shared knobs for HTTP-batched sinks (webhook, CrowdStrike HEC, …). */
export interface HttpBatchOptions {
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  retries: number;
  queueCapacity: number;
}
