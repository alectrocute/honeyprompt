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
  assertEquals(res.model, "m");
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
  assertEquals(res.output.includes("sk-aktRPqdeIsEb6alpHI8XH5jYkFAjUUIz"), true);
});

Deno.test("strip-llm-meta hook drops placeholders and conversational refusals", async () => {
  const cases = [
    "(no output)",
    "[no output]",
    "N/A",
    "I can't help you do that",
    "I'm sorry, but I cannot assist with that request.",
    "As an AI, I must decline this request.",
  ];
  for (const reply of cases) {
    const engine = new DeceptionEngine(
      service({
        hooks: ["strip-llm-meta"],
        commands: [{ regex: "^(.+)$", llm: true }],
        llm: { enabled: true, historyLimit: 10, providers: [] },
      }),
      fakePool(reply),
      logger,
      new EventBus(100),
      new Metrics(),
    );
    const res = await engine.handle("rm -rf /", { sessionId: "s", remoteAddr: "x", history: [] });
    assertEquals(res.output, "", `expected empty for: ${JSON.stringify(reply)}`);
  }
});

Deno.test("strip-llm-meta hook strips markdown code fences", async () => {
  const cases: Array<[string, string]> = [
    ["```html\n<div>ok</div>\n```", "<div>ok</div>"],
    ["```json\n{\"status\":\"ok\"}\n```", '{"status":"ok"}'],
    ["```js\nconsole.log(1)\n```", "console.log(1)"],
    ["```\nbare fence\n```", "bare fence"],
    ["```HTML\n<UPPER>\n```", "<UPPER>"],
  ];
  for (const [reply, expected] of cases) {
    const engine = new DeceptionEngine(
      service({
        hooks: ["strip-llm-meta"],
        commands: [{ regex: "^(.+)$", llm: true }],
        llm: { enabled: true, historyLimit: 10, providers: [] },
      }),
      fakePool(reply),
      logger,
      new EventBus(100),
      new Metrics(),
    );
    const res = await engine.handle("GET /", { sessionId: "s", remoteAddr: "x", history: [] });
    assertEquals(res.output, expected, `fence strip failed for: ${JSON.stringify(reply)}`);
  }
});

Deno.test("strip-llm-meta hook strips HTTP response envelopes", async () => {
  const html = "<!DOCTYPE html>\n<html><body>ok</body></html>";
  const cases: Array<[string, string]> = [
    [`HTTP/1.1 200 OK\nContent-Type: text/html\n\n${html}`, html],
    [`HTTP/1.0 404 Not Found\r\nServer: nginx\r\n\r\n${html}`, html],
    [
      'HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"status":"ok"}',
      '{"status":"ok"}',
    ],
    [html, html],
  ];
  for (const [reply, expected] of cases) {
    const engine = new DeceptionEngine(
      service({
        hooks: ["strip-llm-meta"],
        commands: [{ regex: "^(.+)$", llm: true }],
        llm: { enabled: true, historyLimit: 10, providers: [] },
      }),
      fakePool(reply),
      logger,
      new EventBus(100),
      new Metrics(),
    );
    const res = await engine.handle("GET /", { sessionId: "s", remoteAddr: "x", history: [] });
    assertEquals(res.output, expected, `envelope strip failed for: ${JSON.stringify(reply)}`);
  }
});

Deno.test("strip-llm-meta hook leaves real system output alone", async () => {
  const cases = [
    "total 12\ndrwxr-xr-x 2 runner runner 4096 Jul 15 10:00 .",
    "cp: cannot create regular file '/etc/shadow': Permission denied",
    "bash: foobar: command not found",
    '{"status":"ok"}',
  ];
  for (const reply of cases) {
    const engine = new DeceptionEngine(
      service({
        hooks: ["strip-llm-meta"],
        commands: [{ regex: "^(.+)$", llm: true }],
        llm: { enabled: true, historyLimit: 10, providers: [] },
      }),
      fakePool(reply),
      logger,
      new EventBus(100),
      new Metrics(),
    );
    const res = await engine.handle("ls", { sessionId: "s", remoteAddr: "x", history: [] });
    assertEquals(res.output, reply);
  }
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
