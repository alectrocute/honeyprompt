import { assertEquals } from "@std/assert";
import type { DeceptionEvent } from "../src/observability/events.ts";
import { createLogger } from "../src/observability/logger.ts";
import { Metrics } from "../src/observability/metrics.ts";
import { SinkFanout } from "../src/sinks/fanout.ts";
import { HttpBatchSink, SinkHttpError } from "../src/sinks/http-batch.ts";
import { normalizeEvent } from "../src/sinks/normalize.ts";
import { redactEvent } from "../src/sinks/redact.ts";
import type { Sink, SinkEnvelope } from "../src/sinks/types.ts";

function sampleEvent(overrides: Partial<DeceptionEvent> = {}): DeceptionEvent {
  return {
    id: "evt1",
    ts: "2026-07-12T16:00:00.000Z",
    protocol: "ssh",
    service: "ssh",
    address: ":2222",
    remoteAddr: "203.0.113.9:54321",
    sessionId: "s1",
    input: "ls",
    output: "ok",
    source: "auth",
    meta: { username: "root", password: "hunter2", success: true },
    ...overrides,
  };
}

Deno.test("redactEvent scrubs passwords and sensitive HTTP headers", () => {
  const redacted = redactEvent(sampleEvent({
    input: [
      "GET / HTTP/1.1",
      "Host: example",
      "Authorization: Bearer secret-token",
      "Cookie: session=abc",
      "X-Request-Id: 1",
    ].join("\r\n"),
  }));
  assertEquals(redacted.meta?.password, "[REDACTED]");
  assertEquals(redacted.meta?.username, "root");
  assertEquals(redacted.input.includes("Authorization: [REDACTED]"), true);
  assertEquals(redacted.input.includes("Cookie: [REDACTED]"), true);
  assertEquals(redacted.input.includes("X-Request-Id: 1"), true);
  assertEquals(redacted.input.includes("secret-token"), false);
});

Deno.test("normalizeEvent splits host:port and IPv6 remote addresses", () => {
  const v4 = normalizeEvent(sampleEvent());
  assertEquals(v4.srcIp, "203.0.113.9");
  assertEquals(v4.srcPort, 54321);
  assertEquals(v4.remoteAddr, "203.0.113.9:54321");

  const v6 = normalizeEvent(sampleEvent({ remoteAddr: "[2001:db8::1]:22" }));
  assertEquals(v6.srcIp, "2001:db8::1");
  assertEquals(v6.srcPort, 22);

  const unknown = normalizeEvent(sampleEvent({ remoteAddr: "unknown" }));
  assertEquals(unknown.srcIp, undefined);
  assertEquals(unknown.srcPort, undefined);
});

Deno.test("SinkFanout redacts and normalizes per route", async () => {
  const seen: SinkEnvelope[] = [];
  const remote: Sink = {
    name: "remote",
    write(event) {
      seen.push(event);
    },
    flush: async () => {},
    close: async () => {},
  };
  const localSeen: SinkEnvelope[] = [];
  const local: Sink = {
    name: "local",
    write(event) {
      localSeen.push(event);
    },
    flush: async () => {},
    close: async () => {},
  };

  const fanout = new SinkFanout([
    { sink: local, redact: false, normalize: false },
    { sink: remote, redact: true, normalize: true },
  ]);
  fanout.write(sampleEvent());
  await fanout.flush();

  assertEquals(localSeen[0]!.meta?.password, "hunter2");
  assertEquals(localSeen[0]!.srcIp, undefined);
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.meta?.password, "[REDACTED]");
  assertEquals(seen[0]!.srcIp, "203.0.113.9");
  assertEquals(seen[0]!.srcPort, 54321);
});

class RecordingBatchSink extends HttpBatchSink {
  readonly name = "recording";
  batches: SinkEnvelope[][] = [];
  failStatuses: number[] = [];

  constructor(logger = createLogger("error", "text"), metrics?: Metrics) {
    super(
      {
        batchSize: 2,
        flushIntervalMs: 0,
        timeoutMs: 1000,
        retries: 1,
        queueCapacity: 4,
      },
      logger,
      metrics,
    );
  }

  protected override sendBatch(batch: SinkEnvelope[], _signal: AbortSignal): Promise<void> {
    const status = this.failStatuses.shift();
    if (status !== undefined) {
      return Promise.reject(
        new SinkHttpError(`HTTP ${status}`, status, status === 429 || status >= 500),
      );
    }
    this.batches.push(batch);
    return Promise.resolve();
  }
}

Deno.test("HttpBatchSink flushes on batch size and drops when the queue is full", async () => {
  const metrics = new Metrics();
  const sink = new RecordingBatchSink(createLogger("error", "text"), metrics);
  sink.write(sampleEvent({ id: "1" }));
  assertEquals(sink.batches.length, 0);
  sink.write(sampleEvent({ id: "2" }));
  await sink.flush();
  assertEquals(sink.batches.length, 1);
  assertEquals(sink.batches[0]!.length, 2);

  class CapSink extends HttpBatchSink {
    readonly name = "cap";
    batches: SinkEnvelope[][] = [];
    constructor() {
      super(
        {
          batchSize: 100,
          flushIntervalMs: 0,
          timeoutMs: 1000,
          retries: 0,
          queueCapacity: 3,
        },
        createLogger("error", "text"),
        metrics,
      );
    }
    protected override sendBatch(batch: SinkEnvelope[]): Promise<void> {
      this.batches.push(batch);
      return Promise.resolve();
    }
  }

  const dropSink = new CapSink();
  for (let i = 0; i < 5; i++) dropSink.write(sampleEvent({ id: String(i) }));
  await dropSink.flush();
  assertEquals(dropSink.batches.reduce((n, b) => n + b.length, 0), 3);
  await dropSink.close();
  await sink.close();
});
