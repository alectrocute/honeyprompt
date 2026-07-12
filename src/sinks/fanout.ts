import type { DeceptionEvent } from "../observability/events.ts";
import { normalizeEvent } from "./normalize.ts";
import { redactEvent } from "./redact.ts";
import type { Sink, SinkEnvelope } from "./types.ts";

export interface SinkRoute {
  sink: Sink;
  /** When true, secrets are scrubbed before write. */
  redact: boolean;
  /** When true, `remoteAddr` is split into `srcIp` / `srcPort`. */
  normalize: boolean;
}

/**
 * Fan-out from the event bus to one or more sinks. Preparation (redact /
 * normalize) is per-route so local JSONL can stay full-fidelity while remote
 * adapters export a scrubbed envelope.
 */
export class SinkFanout implements Sink {
  readonly name = "fanout";

  constructor(private readonly routes: SinkRoute[]) {}

  get sinks(): Sink[] {
    return this.routes.map((r) => r.sink);
  }

  write(event: DeceptionEvent): void {
    for (const route of this.routes) {
      try {
        let payload: SinkEnvelope = route.redact ? redactEvent(event) : { ...event };
        if (route.normalize) payload = normalizeEvent(payload);
        route.sink.write(payload);
      } catch {
        // A misbehaving sink must never break event recording.
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.routes.map((r) => r.sink.flush()));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.routes.map((r) => r.sink.close()));
  }
}
