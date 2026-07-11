import { assertEquals } from "@std/assert";
import { DeceptionEngine } from "../src/engine/engine.ts";
import { EventBus } from "../src/observability/events.ts";
import { createLogger } from "../src/observability/logger.ts";
import { Metrics } from "../src/observability/metrics.ts";
import type { ProviderPool } from "../src/providers/pool.ts";
import type { CompletionRequest, CompletionResult } from "../src/providers/types.ts";
import type { ServiceConfig } from "../src/config/schema.ts";

const logger = createLogger("error", "text");

function service(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    protocol: "tcp",
    address: ":0",
    description: "test",
    commands: [],
    llm: { enabled: false, historyLimit: 10, providers: [] },
    hooks: [],
    deadlineSeconds: 60,
    ...overrides,
  };
}

function fakePool(reply: string): ProviderPool {
  return {
    size: 1,
    names: () => ["fake"],
    complete: (_req: CompletionRequest): Promise<CompletionResult> =>
      Promise.resolve({ text: reply, provider: "fake", model: "m" }),
  } as unknown as ProviderPool;
}

Deno.test("engine returns static handler for matching rule", async () => {
  const events = new EventBus(100);
  const engine = new DeceptionEngine(
    service({ commands: [{ regex: "^PING", handler: "+PONG\r\n" }] }),
    undefined,
    logger,
    events,
    new Metrics(),
  );
  const res = await engine.handle("PING", { sessionId: "s", remoteAddr: "1.2.3.4:5", history: [] });
  assertEquals(res.output, "+PONG\r\n");
  assertEquals(res.source, "static");
  assertEquals(events.totals().total, 1);
});

Deno.test("engine routes llm rules through the pool", async () => {
  const engine = new DeceptionEngine(
    service({
      commands: [{ regex: "^(.+)$", llm: true }],
      llm: { enabled: true, historyLimit: 10, providers: [] },
    }),
    fakePool("simulated output"),
    logger,
    new EventBus(100),
    new Metrics(),
  );
  const res = await engine.handle("ls -la", { sessionId: "s", remoteAddr: "x", history: [] });
  assertEquals(res.output, "simulated output");
  assertEquals(res.source, "llm");
  assertEquals(res.provider, "fake");
});

Deno.test("redact-secrets hook scrubs credentials from responses", async () => {
  const engine = new DeceptionEngine(
    service({
      hooks: ["redact-secrets"],
      commands: [{ regex: "^cat", handler: "token=sk-ABCDEFGHIJKLMNOP1234" }],
    }),
    undefined,
    logger,
    new EventBus(100),
    new Metrics(),
  );
  const res = await engine.handle("cat key", { sessionId: "s", remoteAddr: "x", history: [] });
  assertEquals(res.output.includes("sk-REDACTED"), true);
});

Deno.test("metrics render in prometheus format after events", async () => {
  const metrics = new Metrics();
  const engine = new DeceptionEngine(
    service({ commands: [{ regex: "^.*$", handler: "ok" }] }),
    undefined,
    logger,
    new EventBus(100),
    metrics,
  );
  await engine.handle("anything", { sessionId: "s", remoteAddr: "x", history: [] });
  const text = metrics.render();
  assertEquals(text.includes("honeyprompt_events_total"), true);
  assertEquals(text.includes('protocol="tcp"'), true);
});
