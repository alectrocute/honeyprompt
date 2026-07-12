// ssh2 does not publish useful runtime types to Deno.
// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertStringIncludes } from "@std/assert";
import ssh2 from "ssh2";
import { App } from "../src/app.ts";
import type { HoneypromptConfig, ServiceConfig, ServiceProtocol } from "../src/config/schema.ts";
import { DeceptionEngine } from "../src/engine/engine.ts";
import { type DeceptionEvent, EventBus } from "../src/observability/events.ts";
import { createLogger } from "../src/observability/logger.ts";
import { METRICS } from "../src/observability/metric-defs.ts";
import { Metrics } from "../src/observability/metrics.ts";
import { Panel } from "../src/panel/panel.ts";
import { createService } from "../src/services/registry.ts";

const { Client } = ssh2 as any;
const logger = createLogger("error", "text");
const encoder = new TextEncoder();

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function serviceConfig(
  protocol: ServiceProtocol,
  port: number,
  overrides: Partial<ServiceConfig> = {},
): ServiceConfig {
  return {
    protocol,
    address: `127.0.0.1:${port}`,
    description: `test-${protocol}`,
    commands: [{ regex: "^.*$", handler: "ok" }],
    llm: { enabled: false, historyLimit: 0, providers: [] },
    hooks: [],
    deadlineSeconds: 3,
    ...overrides,
  };
}

function serviceWithEvents(config: ServiceConfig, events: EventBus) {
  const engine = new DeceptionEngine(config, undefined, logger, events, new Metrics());
  return createService(config, engine, logger);
}

async function readUntil(
  conn: Deno.Conn,
  needle: string,
  timeoutMs = 3_000,
): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(8 * 1024);
  const deadline = Date.now() + timeoutMs;
  let text = "";

  while (!text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      conn.read(buffer),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${JSON.stringify(needle)}`)),
          remaining,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (n === null) break;
    text += decoder.decode(buffer.subarray(0, n), { stream: true });
  }
  return text;
}

function basicAuth(username: string, password: string): HeadersInit {
  return { authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

Deno.test("HTTP service honors rule status, headers, body matching, and records the exchange", async () => {
  const port = freePort();
  const events = new EventBus(20);
  const config = serviceConfig("http", port, {
    serverVersion: "test-server/1.0",
    commands: [{
      regex: "^POST /items\\?dryRun=true$",
      handler: '{"accepted":true}',
      statusCode: 202,
      headers: ["Content-Type: application/json", "X-Decoy: active"],
    }],
  });
  const service = serviceWithEvents(config, events);
  await service.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/items?dryRun=true`, {
      method: "POST",
      body: '{"name":"payload"}',
      headers: { "content-type": "application/json" },
    });

    assertEquals(response.status, 202);
    assertEquals(response.headers.get("content-type"), "application/json");
    assertEquals(response.headers.get("x-decoy"), "active");
    assertEquals(response.headers.get("server"), "test-server/1.0");
    assertEquals(await response.text(), '{"accepted":true}');

    const event = events.recent().at(-1)!;
    assertEquals(event.source, "static");
    assertStringIncludes(event.input, "POST /items?dryRun=true HTTP/1.1");
    assertStringIncludes(event.input, '{"name":"payload"}');
    assertEquals(event.output, '{"accepted":true}');
  } finally {
    await service.stop();
  }
});

Deno.test("App persists TCP connect and command events as JSON Lines", async () => {
  const port = freePort();
  const dir = await Deno.makeTempDir();
  const eventFile = `${dir}/events/events.jsonl`;
  const service = serviceConfig("tcp", port, {
    commands: [{ regex: "^PING$", handler: "+PONG\r\n" }],
  });
  const config: HoneypromptConfig = {
    logging: { level: "error", format: "text" },
    metrics: { enabled: false },
    panel: { enabled: false, address: "127.0.0.1:0" },
    events: { buffer: 20, file: eventFile },
    providers: [],
    pool: { strategy: "round-robin", order: [] },
    pools: [],
    services: [service],
  };
  const app = new App(config);
  await app.start();

  let conn: Deno.TcpConn | undefined;
  try {
    conn = await Deno.connect({ hostname: "127.0.0.1", port });
    await conn.write(encoder.encode("PING\r\n"));
    assertStringIncludes(await readUntil(conn, "+PONG"), "+PONG");
  } finally {
    conn?.close();
    await app.stop();
  }

  const records = (await Deno.readTextFile(eventFile)).trim().split("\n").map((line) =>
    JSON.parse(line) as DeceptionEvent
  );
  assertEquals(records.map((event) => event.source), ["connect", "static"]);
  assertEquals(records[1]!.input, "PING");
  assertEquals(records[1]!.output, "+PONG\r\n");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("Telnet service authenticates and serves an interactive command", async () => {
  const port = freePort();
  const events = new EventBus(20);
  const config = serviceConfig("telnet", port, {
    serverName: "edge",
    passwordRegex: "^secret$",
    commands: [{ regex: "^show version$", handler: "EdgeOS 7.2" }],
  });
  const service = serviceWithEvents(config, events);
  await service.start();
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });

  try {
    assertStringIncludes(await readUntil(conn, "login: "), "edge login: ");
    await conn.write(encoder.encode("admin\r\n"));
    assertStringIncludes(await readUntil(conn, "Password: "), "Password: ");
    await conn.write(encoder.encode("secret\r\n"));
    assertStringIncludes(await readUntil(conn, "edge> "), "Welcome.");
    await conn.write(encoder.encode("show version\r\n"));
    assertStringIncludes(await readUntil(conn, "edge> "), "EdgeOS 7.2");

    assertEquals(events.recent().map((event) => event.source), ["connect", "auth", "static"]);
    assertEquals(events.recent()[1]!.meta?.success, true);
  } finally {
    conn.close();
    await service.stop();
  }
});

Deno.test("SSH service accepts configured credentials and executes a command", async () => {
  const port = freePort();
  const events = new EventBus(20);
  const config = serviceConfig("ssh", port, {
    serverName: "runner",
    passwordRegex: "^secret$",
    commands: [{ regex: "^whoami$", handler: "runner" }],
  });
  const service = serviceWithEvents(config, events);
  await service.start();

  try {
    assertEquals((await sshExec(port, "whoami")).trim(), "runner");
    assertEquals(events.recent().map((event) => event.source), ["auth", "connect", "static"]);
  } finally {
    await service.stop();
  }
});

Deno.test("Panel protects data endpoints while leaving health and metrics scrapeable", async () => {
  const port = freePort();
  const events = new EventBus(20);
  events.emit({
    protocol: "http",
    service: "api",
    address: ":8000",
    remoteAddr: "127.0.0.1:1234",
    sessionId: "session-1",
    input: "GET /",
    output: "ok",
    source: "static",
  });
  const metrics = new Metrics();
  metrics.count(METRICS.events, { protocol: "http" });
  const panel = new Panel(
    {
      enabled: true,
      address: `127.0.0.1:${port}`,
      auth: { username: "admin", password: "secret" },
    },
    events,
    metrics,
    ["provider-a"],
    logger,
    true,
  );
  await panel.start();

  try {
    assertEquals((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    assertEquals((await fetch(`http://127.0.0.1:${port}/api/events`)).status, 401);

    const authorized = { headers: basicAuth("admin", "secret") };
    const response = await fetch(`http://127.0.0.1:${port}/api/events?limit=1`, authorized);
    assertEquals(response.status, 200);
    const recent = await response.json() as DeceptionEvent[];
    assertEquals(recent.length, 1);
    assertEquals(recent[0]!.input, "GET /");

    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, authorized).then((r) =>
      r.json()
    );
    assertEquals(stats, { total: 1, byProtocol: { http: 1 }, providers: ["provider-a"] });

    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
    assertEquals(metricsResponse.status, 200);
    assertStringIncludes(await metricsResponse.text(), "honeyprompt_events_total");

    const asset = await fetch(`http://127.0.0.1:${port}/`, authorized);
    assertEquals(asset.status, 200);
  } finally {
    await panel.stop();
  }
});

function sshExec(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("SSH test timed out")), 5_000);

    const finish = (error?: Error, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else resolve(output);
    };

    client
      .on("ready", () => {
        client.exec(command, (error: Error | undefined, stream: any) => {
          if (error) return finish(error);
          let output = "";
          stream.on("data", (chunk: Uint8Array) => {
            output += new TextDecoder().decode(chunk);
          });
          stream.on("error", (streamError: Error) => finish(streamError));
          stream.on("close", () => finish(undefined, output));
        });
      })
      .on("error", (error: Error) => finish(error))
      .connect({
        host: "127.0.0.1",
        port,
        username: "root",
        password: "secret",
        readyTimeout: 4_000,
      });
  });
}
