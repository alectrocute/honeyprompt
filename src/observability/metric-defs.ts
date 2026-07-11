import type { MetricDef } from "./metrics.ts";

/** Every metric honeyprompt exposes, declared once with its help text. */
export const METRICS = {
  events: { name: "honeyprompt_events_total", help: "Total deception events" },
  llmRequests: { name: "honeyprompt_llm_requests_total", help: "LLM completions by provider" },
  authAttempts: { name: "honeyprompt_auth_attempts_total", help: "Authentication attempts" },
  engineErrors: { name: "honeyprompt_engine_errors_total", help: "Engine errors by protocol" },
} as const satisfies Record<string, MetricDef>;
