import { parse as parseYaml } from "@std/yaml";
import {
  type CommandRule,
  type CrowdStrikeEventSinkConfig,
  type EventSinkConfig,
  type FileEventSinkConfig,
  type HoneypromptConfig,
  LOG_FORMATS,
  LOG_LEVELS,
  type NamedPoolConfig,
  POOL_STRATEGIES,
  type PoolConfig,
  PROVIDER_TYPES,
  type ProviderConfig,
  SERVICE_PROTOCOLS,
  type ServiceConfig,
  SINK_TYPES,
  WEBHOOK_FORMATS,
  type WebhookEventSinkConfig,
} from "./schema.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Walks a parsed YAML tree replacing ${VAR} and ${VAR:-default} with env values. */
function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
      const env = Deno.env.get(name);
      if (env !== undefined) return env;
      if (fallback !== undefined) return fallback;
      return "";
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v);
    return out;
  }
  return value;
}

type Obj = Record<string, unknown>;

function asObj(v: unknown, path: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError(`${path}: expected a mapping`);
  }
  return v as Obj;
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ConfigError(`${path}: expected a list`);
  return v;
}

function str(o: Obj, key: string, path: string, def?: string): string {
  const v = o[key];
  if (v === undefined || v === null) {
    if (def !== undefined) return def;
    throw new ConfigError(`${path}.${key}: required string is missing`);
  }
  if (typeof v !== "string") throw new ConfigError(`${path}.${key}: expected string`);
  return v;
}

function oneOf<const Values extends readonly string[]>(
  o: Obj,
  key: string,
  path: string,
  values: Values,
  def?: Values[number],
): Values[number] {
  const value = str(o, key, path, def);
  if (!values.some((candidate) => candidate === value)) {
    throw new ConfigError(
      `${path}.${key}: expected one of ${values.join(" | ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as Values[number];
}

function optStr(o: Obj, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ConfigError(`expected string for "${key}"`);
  return v;
}

function num(o: Obj, key: string, path: string, def: number): number {
  const v = o[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${path}.${key}: expected number`);
  }
  return v;
}

function optNum(o: Obj, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new ConfigError(`expected number for "${key}"`);
  return v;
}

function bool(o: Obj, key: string, def: boolean): boolean {
  const v = o[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") throw new ConfigError(`expected boolean for "${key}"`);
  return v;
}

function parseProvider(raw: unknown, i: number): ProviderConfig {
  const path = `providers[${i}]`;
  const o = asObj(raw, path);
  const type = oneOf(o, "type", path, PROVIDER_TYPES);
  const azureRaw = o["azure"];
  let azure: ProviderConfig["azure"];
  if (azureRaw !== undefined) {
    const a = asObj(azureRaw, `${path}.azure`);
    azure = {
      deployment: str(a, "deployment", `${path}.azure`),
      apiVersion: str(a, "apiVersion", `${path}.azure`, "2024-06-01"),
    };
  }
  if (type === "azure" && !azure) {
    throw new ConfigError(`${path}.azure: azure provider requires an "azure" block`);
  }
  if (type === "azure" && !optStr(o, "baseUrl")) {
    throw new ConfigError(`${path}.baseUrl: azure provider requires the resource baseUrl`);
  }

  let rateLimit: ProviderConfig["rateLimit"];
  const rlRaw = o["rateLimit"];
  if (rlRaw !== undefined) {
    const rl = asObj(rlRaw, `${path}.rateLimit`);
    rateLimit = {
      rps: num(rl, "rps", `${path}.rateLimit`, 0),
      burst: num(rl, "burst", `${path}.rateLimit`, 0),
    };
  }

  let headers: Record<string, string> | undefined;
  const hRaw = o["headers"];
  if (hRaw !== undefined) {
    const h = asObj(hRaw, `${path}.headers`);
    headers = {};
    for (const [k, v] of Object.entries(h)) headers[k] = String(v);
  }

  return {
    name: str(o, "name", path),
    type,
    model: str(o, "model", path),
    baseUrl: optStr(o, "baseUrl"),
    apiKeyEnv: optStr(o, "apiKeyEnv"),
    azure,
    weight: num(o, "weight", path, 1),
    timeoutMs: num(o, "timeoutMs", path, 30_000),
    retries: num(o, "retries", path, 2),
    temperature: optNum(o, "temperature"),
    maxTokens: optNum(o, "maxTokens"),
    rateLimit,
    headers,
  };
}

function parseCommand(raw: unknown, path: string): CommandRule {
  const o = asObj(raw, path);
  const rule: CommandRule = { regex: str(o, "regex", path) };
  try {
    new RegExp(rule.regex);
  } catch (e) {
    throw new ConfigError(`${path}.regex: invalid regex: ${(e as Error).message}`);
  }
  rule.handler = optStr(o, "handler");
  rule.llm = bool(o, "llm", false);
  rule.statusCode = optNum(o, "statusCode");
  const headers = o["headers"];
  if (headers !== undefined) {
    rule.headers = asArray(headers, `${path}.headers`).map((h) => String(h));
  }
  if (!rule.handler && !rule.llm) {
    throw new ConfigError(`${path}: a command needs either "handler" or "llm: true"`);
  }
  return rule;
}

function parseService(raw: unknown, i: number): ServiceConfig {
  const path = `services[${i}]`;
  const o = asObj(raw, path);
  const protocol = oneOf(o, "protocol", path, SERVICE_PROTOCOLS);

  const commandsRaw = o["commands"] ?? [];
  const commands = asArray(commandsRaw, `${path}.commands`).map((c, j) =>
    parseCommand(c, `${path}.commands[${j}]`)
  );

  let llm: ServiceConfig["llm"] = { enabled: false, historyLimit: 20, providers: [] };
  const llmRaw = o["llm"];
  if (llmRaw !== undefined) {
    const l = asObj(llmRaw, `${path}.llm`);
    const providersRaw = l["providers"] ?? [];
    llm = {
      enabled: bool(l, "enabled", false),
      prompt: optStr(l, "prompt"),
      historyLimit: num(l, "historyLimit", `${path}.llm`, 20),
      providers: asArray(providersRaw, `${path}.llm.providers`).map((p) => String(p)),
    };
  }

  let tls: ServiceConfig["tls"];
  const tlsRaw = o["tls"];
  if (tlsRaw !== undefined) {
    const t = asObj(tlsRaw, `${path}.tls`);
    tls = {
      certFile: str(t, "certFile", `${path}.tls`),
      keyFile: str(t, "keyFile", `${path}.tls`),
    };
  }

  const hooksRaw = o["hooks"] ?? [];
  const hooks = asArray(hooksRaw, `${path}.hooks`).map((h) => String(h));

  const usesLlm = llm.enabled || commands.some((c) => c.llm);
  if (commands.length === 0 && !usesLlm) {
    throw new ConfigError(`${path}: service has no commands and no LLM fallback`);
  }

  return {
    protocol,
    address: str(o, "address", path),
    description: str(o, "description", path, ""),
    tls,
    commands,
    llm,
    hooks,
    deadlineSeconds: num(o, "deadlineSeconds", path, 60),
    banner: optStr(o, "banner"),
    serverName: optStr(o, "serverName"),
    serverVersion: optStr(o, "serverVersion"),
    passwordRegex: optStr(o, "passwordRegex"),
    hostKeyFile: optStr(o, "hostKeyFile"),
  };
}

function parsePool(raw: unknown, providers: ProviderConfig[]): PoolConfig {
  if (raw === undefined) return { strategy: "round-robin", order: [] };
  const o = asObj(raw, "pool");
  const strategy = oneOf(o, "strategy", "pool", POOL_STRATEGIES, "round-robin");
  const order = (o["order"] ? asArray(o["order"], "pool.order") : []).map((x) => String(x));
  const known = new Set(providers.map((p) => p.name));
  for (const name of order) {
    if (!known.has(name)) throw new ConfigError(`pool.order: unknown provider "${name}"`);
  }
  return { strategy, order };
}

function parseNamedPools(raw: unknown, providers: ProviderConfig[]): NamedPoolConfig[] {
  if (raw === undefined) return [];
  const providerNames = new Set(providers.map((p) => p.name));
  const poolNames = new Set<string>();

  return asArray(raw, "pools").map((entry, i) => {
    const path = `pools[${i}]`;
    const o = asObj(entry, path);
    const name = str(o, "name", path);
    if (poolNames.has(name)) throw new ConfigError(`pools: duplicate name "${name}"`);
    if (providerNames.has(name)) {
      throw new ConfigError(`${path}.name: "${name}" collides with a provider name`);
    }
    poolNames.add(name);

    const strategy = oneOf(o, "strategy", path, POOL_STRATEGIES, "round-robin");
    const order = asArray(o["order"] ?? [], `${path}.order`).map((x) => String(x));
    if (order.length === 0) {
      throw new ConfigError(`${path}.order: a named pool needs at least one provider`);
    }
    for (const provider of order) {
      if (!providerNames.has(provider)) {
        throw new ConfigError(`${path}.order: unknown provider "${provider}"`);
      }
    }
    return { name, strategy, order };
  });
}

const DEFAULT_HTTP_BATCH = {
  batchSize: 50,
  flushIntervalMs: 2000,
  timeoutMs: 10_000,
  retries: 3,
  queueCapacity: 1000,
} as const;

function parseDelivery(
  o: Obj,
  path: string,
  redactDefault: boolean,
): {
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  retries: number;
  queueCapacity: number;
  redact: boolean;
} {
  return {
    batchSize: num(o, "batchSize", path, DEFAULT_HTTP_BATCH.batchSize),
    flushIntervalMs: num(o, "flushIntervalMs", path, DEFAULT_HTTP_BATCH.flushIntervalMs),
    timeoutMs: num(o, "timeoutMs", path, DEFAULT_HTTP_BATCH.timeoutMs),
    retries: num(o, "retries", path, DEFAULT_HTTP_BATCH.retries),
    queueCapacity: num(o, "queueCapacity", path, DEFAULT_HTTP_BATCH.queueCapacity),
    redact: bool(o, "redact", redactDefault),
  };
}

function parseEventSink(raw: unknown, i: number): EventSinkConfig {
  const path = `events.sinks[${i}]`;
  const o = asObj(raw, path);
  const type = oneOf(o, "type", path, SINK_TYPES);
  const name = str(o, "name", path);

  if (type === "file") {
    const cfg: FileEventSinkConfig = {
      name,
      type,
      path: str(o, "path", path),
      redact: bool(o, "redact", false),
    };
    return cfg;
  }

  if (type === "webhook") {
    let headers: Record<string, string> | undefined;
    const hRaw = o["headers"];
    if (hRaw !== undefined) {
      const h = asObj(hRaw, `${path}.headers`);
      headers = {};
      for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    }
    const cfg: WebhookEventSinkConfig = {
      name,
      type,
      url: str(o, "url", path),
      headers,
      format: oneOf(o, "format", path, WEBHOOK_FORMATS, "ndjson"),
      ...parseDelivery(o, path, true),
    };
    return cfg;
  }

  // crowdstrike
  const cfg: CrowdStrikeEventSinkConfig = {
    name,
    type,
    url: str(o, "url", path),
    tokenEnv: str(o, "tokenEnv", path),
    sourcetype: str(o, "sourcetype", path, "honeyprompt"),
    source: str(o, "source", path, "honeyprompt"),
    host: str(o, "host", path, "honeyprompt"),
    ...parseDelivery(o, path, true),
  };
  return cfg;
}

function parseEventSinks(raw: unknown): EventSinkConfig[] {
  if (raw === undefined) return [];
  const sinks = asArray(raw, "events.sinks").map(parseEventSink);
  const names = new Set<string>();
  for (const sink of sinks) {
    if (names.has(sink.name)) {
      throw new ConfigError(`events.sinks: duplicate name "${sink.name}"`);
    }
    names.add(sink.name);
  }
  return sinks;
}

export function parseConfig(rawInput: unknown): HoneypromptConfig {
  const raw = interpolateEnv(rawInput);
  const root = asObj(raw, "root");

  const loggingRaw = root["logging"] ? asObj(root["logging"], "logging") : {};
  const level = oneOf(loggingRaw, "level", "logging", LOG_LEVELS, "info");
  const format = oneOf(loggingRaw, "format", "logging", LOG_FORMATS, "text");

  const metricsRaw = root["metrics"] ? asObj(root["metrics"], "metrics") : {};
  const eventsRaw = root["events"] ? asObj(root["events"], "events") : {};

  const panelRaw = root["panel"] ? asObj(root["panel"], "panel") : {};
  let panelAuth;
  if (panelRaw["auth"] !== undefined) {
    const a = asObj(panelRaw["auth"], "panel.auth");
    panelAuth = {
      username: str(a, "username", "panel.auth"),
      password: str(a, "password", "panel.auth"),
    };
  }

  const providers = asArray(root["providers"] ?? [], "providers").map(parseProvider);
  const names = new Set<string>();
  for (const p of providers) {
    if (names.has(p.name)) throw new ConfigError(`providers: duplicate name "${p.name}"`);
    names.add(p.name);
  }

  const services = asArray(root["services"] ?? [], "services").map(parseService);
  if (services.length === 0) throw new ConfigError(`services: at least one service is required`);

  const usesLlm = services.some((s) => s.llm.enabled || s.commands.some((c) => c.llm));
  if (usesLlm && providers.length === 0) {
    throw new ConfigError(`providers: LLM-backed services are configured but no providers exist`);
  }

  const pools = parseNamedPools(root["pools"], providers);

  const providerNames = new Set(providers.map((p) => p.name));
  const poolNames = new Set(pools.map((p) => p.name));
  services.forEach((svc, i) => {
    for (const name of svc.llm.providers) {
      if (poolNames.has(name)) {
        if (svc.llm.providers.length > 1) {
          throw new ConfigError(
            `services[${i}].llm.providers: pool "${name}" cannot be mixed with other entries`,
          );
        }
      } else if (!providerNames.has(name)) {
        throw new ConfigError(
          `services[${i}].llm.providers: unknown provider or pool "${name}"`,
        );
      }
    }
  });

  return {
    logging: {
      level,
      format,
      file: optStr(loggingRaw, "file"),
    },
    metrics: { enabled: bool(metricsRaw, "enabled", true) },
    panel: {
      enabled: bool(panelRaw, "enabled", false),
      address: str(panelRaw, "address", "panel", "127.0.0.1:8080"),
      auth: panelAuth,
    },
    events: {
      buffer: num(eventsRaw, "buffer", "events", 1000),
      file: optStr(eventsRaw, "file"),
      sinks: parseEventSinks(eventsRaw["sinks"]),
    },
    providers,
    pool: parsePool(root["pool"], providers),
    pools,
    services,
  };
}

export async function loadConfig(path: string): Promise<HoneypromptConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    throw new ConfigError(`could not read config file "${path}": ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`could not parse YAML in "${path}": ${(e as Error).message}`);
  }
  return parseConfig(parsed);
}
