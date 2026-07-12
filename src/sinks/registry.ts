import type { EventsConfig, EventSinkConfig } from "../config/schema.ts";
import type { Logger } from "../observability/logger.ts";
import type { Metrics } from "../observability/metrics.ts";
import { CrowdStrikeHecSink } from "./crowdstrike.ts";
import { SinkFanout, type SinkRoute } from "./fanout.ts";
import { FileEventSink } from "./file.ts";
import type { Sink } from "./types.ts";
import { WebhookSink } from "./webhook.ts";

/**
 * Builds the fan-out pipeline from `events.file` + `events.sinks`. The shorthand
 * `events.file` is treated as an implicit file sink named `file` unless a sink
 * already targets the same path.
 */
export function createEventSinks(
  events: EventsConfig,
  logger: Logger,
  metrics?: Metrics,
): SinkFanout | undefined {
  const configs = mergeFileShorthand(events);
  if (configs.length === 0) return undefined;

  const routes: SinkRoute[] = configs.map((cfg) => {
    const sink = createSink(cfg, logger, metrics);
    const remote = cfg.type !== "file";
    return {
      sink,
      redact: cfg.redact,
      // Remote sinks get srcIp/srcPort; local JSONL stays a pure DeceptionEvent.
      normalize: remote,
    };
  });

  return new SinkFanout(routes);
}

function mergeFileShorthand(events: EventsConfig): EventSinkConfig[] {
  const sinks = [...events.sinks];
  if (!events.file) return sinks;

  const already = sinks.some((s) => s.type === "file" && s.path === events.file);
  if (already) return sinks;

  sinks.unshift({
    name: "file",
    type: "file",
    path: events.file,
    redact: false,
  });
  return sinks;
}

export function createSink(
  cfg: EventSinkConfig,
  logger: Logger,
  metrics?: Metrics,
): Sink {
  switch (cfg.type) {
    case "file":
      return new FileEventSink(cfg.name, cfg.path);
    case "webhook":
      return new WebhookSink(
        {
          name: cfg.name,
          url: cfg.url,
          headers: cfg.headers,
          format: cfg.format,
          batchSize: cfg.batchSize,
          flushIntervalMs: cfg.flushIntervalMs,
          timeoutMs: cfg.timeoutMs,
          retries: cfg.retries,
          queueCapacity: cfg.queueCapacity,
        },
        logger,
        metrics,
      );
    case "crowdstrike":
      return new CrowdStrikeHecSink(
        {
          name: cfg.name,
          url: cfg.url,
          tokenEnv: cfg.tokenEnv,
          sourcetype: cfg.sourcetype,
          source: cfg.source,
          host: cfg.host,
          batchSize: cfg.batchSize,
          flushIntervalMs: cfg.flushIntervalMs,
          timeoutMs: cfg.timeoutMs,
          retries: cfg.retries,
          queueCapacity: cfg.queueCapacity,
        },
        logger,
        metrics,
      );
  }
}
