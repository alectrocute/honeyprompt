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
  assertEquals(c.events.sinks, []);
});

Deno.test("parseConfig parses webhook and crowdstrike event sinks", () => {
  const c = parseConfig(cfg(`
events:
  sinks:
    - name: hook
      type: webhook
      url: https://example.com/hooks/hp
      format: json-array
      headers:
        X-Token: "\${HOOK_TOKEN:-none}"
    - name: crowdstrike
      type: crowdstrike
      url: https://abc.ingest.us-1.crowdstrike.com
      tokenEnv: CROWDSTRIKE_HEC_TOKEN
      host: decoy-1
      batchSize: 25
services:
  - protocol: tcp
    address: ":1"
    description: x
    commands:
      - regex: "^.*$"
        handler: "hi"
`));
  assertEquals(c.events.sinks.length, 2);
  assertEquals(c.events.sinks[0], {
    name: "hook",
    type: "webhook",
    url: "https://example.com/hooks/hp",
    format: "json-array",
    headers: { "X-Token": "none" },
    batchSize: 50,
    flushIntervalMs: 2000,
    timeoutMs: 10_000,
    retries: 3,
    queueCapacity: 1000,
    redact: true,
  });
  assertEquals(c.events.sinks[1], {
    name: "crowdstrike",
    type: "crowdstrike",
    url: "https://abc.ingest.us-1.crowdstrike.com",
    tokenEnv: "CROWDSTRIKE_HEC_TOKEN",
    sourcetype: "honeyprompt",
    source: "honeyprompt",
    host: "decoy-1",
    batchSize: 25,
    flushIntervalMs: 2000,
    timeoutMs: 10_000,
    retries: 3,
    queueCapacity: 1000,
    redact: true,
  });
});

Deno.test("parseConfig rejects invalid event sinks", () => {
  const base = STATIC_SERVICE;
  assertThrows(
    () =>
      parseConfig(cfg(`
events:
  sinks:
    - name: bad
      type: syslog
      url: http://x
${base}`)),
    ConfigError,
    "events.sinks[0].type",
  );
  assertThrows(
    () =>
      parseConfig(cfg(`
events:
  sinks:
    - name: cs
      type: crowdstrike
      url: https://abc.ingest.us-1.crowdstrike.com
${base}`)),
    ConfigError,
    "tokenEnv",
  );
  assertThrows(
    () =>
      parseConfig(cfg(`
events:
  sinks:
    - name: dup
      type: file
      path: /tmp/a.jsonl
    - name: dup
      type: file
      path: /tmp/b.jsonl
${base}`)),
    ConfigError,
    "duplicate",
  );
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

Deno.test("parseConfig parses named pools and lets a service reference one", () => {
  const c = parseConfig(cfg(`
providers:
  - name: primary
    type: ollama
    model: a
  - name: backup
    type: ollama
    model: b
pools:
  - name: resilient
    strategy: failover
    order: [primary, backup]
services:
  - protocol: ssh
    address: ":2222"
    description: jump
    llm:
      enabled: true
      providers: [resilient]
    commands:
      - regex: "^(.+)$"
        llm: true
`));
  assertEquals(c.pools, [{
    name: "resilient",
    strategy: "failover",
    order: ["primary", "backup"],
  }]);
  assertEquals(c.services[0]!.llm.providers, ["resilient"]);
});

Deno.test("parseConfig rejects invalid named pools", () => {
  const base = `
providers:
  - name: primary
    type: ollama
    model: a
${STATIC_SERVICE}`;
  const invalid = [
    { message: "at least one provider", pools: `pools:\n  - name: empty\n    strategy: failover` },
    {
      message: "unknown provider",
      pools: `pools:\n  - name: p\n    strategy: failover\n    order: [ghost]`,
    },
    {
      message: "duplicate",
      pools: `pools:\n  - name: p\n    order: [primary]\n  - name: p\n    order: [primary]`,
    },
    {
      message: "collides with a provider",
      pools: `pools:\n  - name: primary\n    order: [primary]`,
    },
  ];
  for (const test of invalid) {
    assertThrows(() => parseConfig(cfg(base + test.pools)), ConfigError, test.message);
  }
});

Deno.test("parseConfig rejects mixing a pool with other providers in a service", () => {
  assertThrows(
    () =>
      parseConfig(cfg(`
providers:
  - name: primary
    type: ollama
    model: a
pools:
  - name: mixed
    order: [primary]
services:
  - protocol: ssh
    address: ":2222"
    description: jump
    llm:
      enabled: true
      providers: [mixed, primary]
    commands:
      - regex: "^(.+)$"
        llm: true
`)),
    ConfigError,
    "cannot be mixed",
  );
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
