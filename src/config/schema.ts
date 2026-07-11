/** Closed config vocabularies are declared once and reused for runtime validation. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["json", "text"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/**
 * Operational logging: honeyprompt's own diagnostics (startup, bound ports,
 * provider failures, errors) — deliberately separate from captured attacker
 * activity, which lives in {@link EventsConfig}.
 */
export interface LoggingConfig {
  level: LogLevel;
  /** Console rendering only; the on-disk file is always structured JSON. */
  format: LogFormat;
  /** Optional path to also append operational logs to, as JSON lines. */
  file?: string;
}

export interface MetricsConfig {
  enabled: boolean;
}

export interface BasicAuthConfig {
  username: string;
  /** Plaintext password from config; honeyprompt compares it in constant time. */
  password: string;
}

export interface PanelConfig {
  enabled: boolean;
  address: string;
  auth?: BasicAuthConfig;
}

/**
 * Deception events: the captured attacker activity — every connection, auth
 * attempt, command, and the response honeyprompt returned. This is the honey.
 */
export interface EventsConfig {
  /** Size of the in-memory ring buffer surfaced by the panel. */
  buffer: number;
  /** Optional path to persist every event to, as JSON Lines (one event per line). */
  file?: string;
}

export interface RateLimitConfig {
  /** Sustained requests per second allowed toward the provider. */
  rps: number;
  /** Maximum burst size (token bucket capacity). */
  burst: number;
}

export const PROVIDER_TYPES = [
  "openai",
  "openai-compatible",
  "azure",
  "openrouter",
  "anthropic",
  "google",
  "ollama",
  "llamacpp",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  model: string;
  /** Base URL of the API. Sensible defaults are applied per provider type. */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Azure-only: deployment name and api-version. */
  azure?: { deployment: string; apiVersion: string };
  /** Relative selection weight for weighted strategies. Defaults to 1. */
  weight: number;
  timeoutMs: number;
  retries: number;
  /** Sampling temperature forwarded to the provider. */
  temperature?: number;
  maxTokens?: number;
  rateLimit?: RateLimitConfig;
  /** Arbitrary extra headers merged into every request. */
  headers?: Record<string, string>;
}

export const POOL_STRATEGIES = ["round-robin", "weighted", "random", "failover"] as const;
export type PoolStrategy = (typeof POOL_STRATEGIES)[number];

export interface PoolConfig {
  strategy: PoolStrategy;
  /** Explicit provider order/subset by name. Empty means "all, as declared". */
  order: string[];
}

export const SERVICE_PROTOCOLS = ["http", "tcp", "telnet", "ssh"] as const;
export type ServiceProtocol = (typeof SERVICE_PROTOCOLS)[number];

export interface CommandRule {
  /** Regex matched against the incoming command / request line / path. */
  regex: string;
  /** Static response. Mutually exclusive with `llm`. */
  handler?: string;
  /** If true, this rule is answered by the LLM pool. */
  llm?: boolean;
  /** HTTP-only: response headers as "Key: Value" strings. */
  headers?: string[];
  /** HTTP-only: status code. Defaults to 200. */
  statusCode?: number;
}

export interface ServiceLLMConfig {
  enabled: boolean;
  /** System prompt override. A protocol-appropriate default is used otherwise. */
  prompt?: string;
  /** Number of prior turns kept per session for interactive protocols. */
  historyLimit: number;
  /**
   * Restrict this service to these providers (by name), overriding the global
   * pool. List one to pin the service to a single provider; list several to
   * load-balance and fail over only among them. Empty means "use the pool".
   */
  providers: string[];
}

export interface ServiceConfig {
  protocol: ServiceProtocol;
  address: string;
  description: string;
  /** TLS for HTTP services. */
  tls?: { certFile: string; keyFile: string };
  commands: CommandRule[];
  llm: ServiceLLMConfig;
  /** Named hooks applied to this service, in order. */
  hooks: string[];
  /** Idle timeout for a connection/session in seconds. */
  deadlineSeconds: number;
  /** TCP/SSH/TELNET banner or server identity fields. */
  banner?: string;
  serverName?: string;
  serverVersion?: string;
  /** SSH/TELNET password acceptance regex. Empty accepts anything. */
  passwordRegex?: string;
  /** SSH-only: path to a host private key. Generated in-memory if omitted. */
  hostKeyFile?: string;
}

export interface HoneypromptConfig {
  logging: LoggingConfig;
  metrics: MetricsConfig;
  panel: PanelConfig;
  events: EventsConfig;
  providers: ProviderConfig[];
  pool: PoolConfig;
  services: ServiceConfig[];
}
