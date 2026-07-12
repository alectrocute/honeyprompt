import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger } from "../src/observability/logger.ts";
import { CrowdStrikeHecSink, hecTime, normalizeHecUrl } from "../src/sinks/crowdstrike.ts";
import type { SinkEnvelope } from "../src/sinks/types.ts";

function envelope(overrides: Partial<SinkEnvelope> = {}): SinkEnvelope {
  return {
    id: "evt1",
    ts: "2026-07-12T16:00:00.000Z",
    protocol: "tcp",
    service: "redis",
    address: ":6379",
    remoteAddr: "198.51.100.7:4000",
    sessionId: "s1",
    input: "PING",
    output: "+PONG",
    source: "static",
    srcIp: "198.51.100.7",
    srcPort: 4000,
    ...overrides,
  };
}

Deno.test("normalizeHecUrl appends /services/collector when path is empty", () => {
  assertEquals(
    normalizeHecUrl("https://abc.ingest.us-1.crowdstrike.com"),
    "https://abc.ingest.us-1.crowdstrike.com/services/collector",
  );
  assertEquals(
    normalizeHecUrl("https://abc.ingest.us-1.crowdstrike.com/"),
    "https://abc.ingest.us-1.crowdstrike.com/services/collector",
  );
  assertEquals(
    normalizeHecUrl("https://abc.ingest.us-1.crowdstrike.com/services/collector"),
    "https://abc.ingest.us-1.crowdstrike.com/services/collector",
  );
  assertEquals(
    normalizeHecUrl("https://abc.ingest.us-1.crowdstrike.com/services/collector/raw"),
    "https://abc.ingest.us-1.crowdstrike.com/services/collector/raw",
  );
});

Deno.test("hecTime converts ISO timestamps to unix seconds", () => {
  assertEquals(hecTime("2026-07-12T16:00:00.000Z"), Date.parse("2026-07-12T16:00:00.000Z") / 1000);
});

Deno.test("CrowdStrikeHecSink posts concatenated HEC JSON with Bearer auth", async () => {
  const previous = Deno.env.get("TEST_CS_HEC_TOKEN");
  Deno.env.set("TEST_CS_HEC_TOKEN", "hec-secret");

  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers, body: String(init?.body ?? "") });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  try {
    const sink = new CrowdStrikeHecSink(
      {
        name: "crowdstrike",
        url: "https://abc.ingest.us-1.crowdstrike.com",
        tokenEnv: "TEST_CS_HEC_TOKEN",
        sourcetype: "honeyprompt",
        source: "honeyprompt",
        host: "decoy-1",
        batchSize: 10,
        flushIntervalMs: 0,
        timeoutMs: 5000,
        retries: 0,
        queueCapacity: 100,
      },
      createLogger("error", "text"),
    );

    sink.write(envelope({ id: "a" }));
    sink.write(envelope({ id: "b", input: "INFO" }));
    await sink.flush();
    await sink.close();

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.url, "https://abc.ingest.us-1.crowdstrike.com/services/collector");
    assertEquals(calls[0]!.headers.get("authorization"), "Bearer hec-secret");
    assertStringIncludes(calls[0]!.headers.get("content-type") ?? "", "application/json");

    // Concatenated JSON objects (no array wrapper).
    const body = calls[0]!.body;
    const first = JSON.parse(body.slice(0, body.indexOf("}{") + 1));
    const second = JSON.parse(body.slice(body.indexOf("}{") + 1));
    assertEquals(first.host, "decoy-1");
    assertEquals(first.source, "honeyprompt");
    assertEquals(first.sourcetype, "honeyprompt");
    assertEquals(first.time, Date.parse("2026-07-12T16:00:00.000Z") / 1000);
    assertEquals(first.event.id, "a");
    assertEquals(second.event.id, "b");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete("TEST_CS_HEC_TOKEN");
    else Deno.env.set("TEST_CS_HEC_TOKEN", previous);
  }
});

Deno.test("CrowdStrikeHecSink retries retryable HTTP statuses", async () => {
  const previous = Deno.env.get("TEST_CS_HEC_TOKEN");
  Deno.env.set("TEST_CS_HEC_TOKEN", "hec-secret");

  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    attempts++;
    if (attempts === 1) return Promise.resolve(new Response("busy", { status: 429 }));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  try {
    const sink = new CrowdStrikeHecSink(
      {
        name: "crowdstrike",
        url: "https://abc.ingest.us-1.crowdstrike.com/services/collector",
        tokenEnv: "TEST_CS_HEC_TOKEN",
        sourcetype: "honeyprompt",
        source: "honeyprompt",
        host: "decoy-1",
        batchSize: 1,
        flushIntervalMs: 0,
        timeoutMs: 5000,
        retries: 2,
        queueCapacity: 100,
      },
      createLogger("error", "text"),
    );
    sink.write(envelope());
    await sink.flush();
    await sink.close();
    assertEquals(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete("TEST_CS_HEC_TOKEN");
    else Deno.env.set("TEST_CS_HEC_TOKEN", previous);
  }
});
