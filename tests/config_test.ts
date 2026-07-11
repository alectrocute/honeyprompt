import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig, parseConfig } from "../src/config/load.ts";
import { parse as parseYaml } from "@std/yaml";

function cfg(yaml: string): unknown {
  return parseYaml(yaml);
}

const STATIC_SERVICE = `
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "^.*$"
        handler: "ok"
`;

Deno.test("parseConfig applies defaults and parses a minimal service", () => {
  const c = parseConfig(cfg(`
services:
  - protocol: tcp
    address: ":6379"
    description: Redis
    commands:
      - regex: "^PING"
        handler: "+PONG\\r\\n"
`));
  assertEquals(c.services.length, 1);
  assertEquals(c.pool.strategy, "round-robin");
  assertEquals(c.panel.enabled, false);
  assertEquals(c.logging.level, "info");
  assertEquals(c.services[0]!.deadlineSeconds, 60);
});

Deno.test("parseConfig validates closed vocabularies from their canonical schema values", () => {
  const invalid = [
    { path: "logging.level", yaml: `logging:\n  level: verbose\n${STATIC_SERVICE}` },
    { path: "logging.format", yaml: `logging:\n  format: yaml\n${STATIC_SERVICE}` },
    {
      path: "providers[0].type",
      yaml: `providers:\n  - name: bad\n    type: magic\n    model: x\n${STATIC_SERVICE}`,
    },
    { path: "pool.strategy", yaml: `pool:\n  strategy: fastest\n${STATIC_SERVICE}` },
    {
      path: "services[0].protocol",
      yaml:
        `services:\n  - protocol: smtp\n    address: ":25"\n    commands:\n      - regex: "^.*$"\n        handler: "ok"`,
    },
  ];

  for (const test of invalid) {
    assertThrows(() => parseConfig(cfg(test.yaml)), ConfigError, test.path);
  }
});

Deno.test("parseConfig rejects a command with neither handler nor llm", () => {
  assertThrows(
    () =>
      parseConfig(cfg(`
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "^.*$"
`)),
    ConfigError,
  );
});

Deno.test("parseConfig requires providers when a service uses the LLM", () => {
  assertThrows(
    () =>
      parseConfig(cfg(`
services:
  - protocol: ssh
    address: ":2222"
    description: x
    llm:
      enabled: true
    commands:
      - regex: "^(.+)$"
        llm: true
`)),
    ConfigError,
    "no providers",
  );
});

Deno.test("parseConfig rejects invalid regex", () => {
  assertThrows(
    () =>
      parseConfig(cfg(`
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "([unclosed"
        handler: "x"
`)),
    ConfigError,
    "invalid regex",
  );
});

Deno.test("parseConfig interpolates environment variables", () => {
  Deno.env.set("HONEYPROMPT_TEST_PW", "s3cret");
  const c = parseConfig(cfg(`
panel:
  enabled: true
  auth:
    username: admin
    password: "\${HONEYPROMPT_TEST_PW}"
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "^.*$"
        handler: "hi"
`));
  assertEquals(c.panel.auth?.password, "s3cret");
});

Deno.test("parseConfig parses optional on-disk logging and event sinks", () => {
  const c = parseConfig(cfg(`
logging:
  level: debug
  file: /var/log/honeyprompt/honeyprompt.log
events:
  buffer: 500
  file: /var/log/honeyprompt/events.jsonl
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "^.*$"
        handler: "hi"
`));
  assertEquals(c.logging.file, "/var/log/honeyprompt/honeyprompt.log");
  assertEquals(c.events.file, "/var/log/honeyprompt/events.jsonl");
  assertEquals(c.events.buffer, 500);
});

Deno.test("parseConfig pins a service to specific providers", () => {
  const c = parseConfig(cfg(`
providers:
  - name: primary
    type: ollama
    model: a
  - name: backup
    type: ollama
    model: b
services:
  - protocol: ssh
    address: ":2222"
    description: jump
    llm:
      enabled: true
      providers: [backup]
    commands:
      - regex: "^(.+)$"
        llm: true
`));
  assertEquals(c.services[0]!.llm.providers, ["backup"]);
});

Deno.test("parseConfig rejects a service pinned to an unknown provider", () => {
  assertThrows(
    () =>
      parseConfig(cfg(`
providers:
  - name: primary
    type: ollama
    model: a
services:
  - protocol: ssh
    address: ":2222"
    description: jump
    llm:
      enabled: true
      providers: [nope]
    commands:
      - regex: "^(.+)$"
        llm: true
`)),
    ConfigError,
    "unknown provider",
  );
});

Deno.test("parseConfig rejects duplicate provider names", () => {
  assertThrows(
    () =>
      parseConfig(cfg(`
providers:
  - name: dup
    type: ollama
    model: a
  - name: dup
    type: ollama
    model: b
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "^.*$"
        handler: "hi"
`)),
    ConfigError,
    "duplicate",
  );
});

Deno.test("shipped config persists events locally and honors the container path override", async () => {
  const previous = Deno.env.get("HONEYPROMPT_EVENT_FILE");
  try {
    Deno.env.delete("HONEYPROMPT_EVENT_FILE");
    assertEquals((await loadConfig("honeyprompt.yaml")).events.file, "./data/events.jsonl");

    Deno.env.set("HONEYPROMPT_EVENT_FILE", "/data/events.jsonl");
    assertEquals((await loadConfig("honeyprompt.yaml")).events.file, "/data/events.jsonl");
  } finally {
    if (previous === undefined) Deno.env.delete("HONEYPROMPT_EVENT_FILE");
    else Deno.env.set("HONEYPROMPT_EVENT_FILE", previous);
  }
});
