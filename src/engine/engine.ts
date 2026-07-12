import type { CommandRule, ServiceConfig } from "../config/schema.ts";
import type { DeceptionEvent, EventBus } from "../observability/events.ts";
import type { Logger } from "../observability/logger.ts";
import { METRICS } from "../observability/metric-defs.ts";
import type { Metrics } from "../observability/metrics.ts";
import type { ProviderPool } from "../providers/pool.ts";
import type { ChatMessage } from "../providers/types.ts";
import { truncate } from "../util/text.ts";
import { getHook, type Hook, type HookContext, resolveHooks } from "./hooks.ts";
import { systemPrompt } from "./prompts.ts";

interface CompiledRule {
  regex: RegExp;
  rule: CommandRule;
}

export interface TurnContext {
  sessionId: string;
  remoteAddr: string;
  /** Prior conversation turns for interactive protocols. */
  history: ChatMessage[];
}

export type ResponseSource = "static" | "llm" | "error";

export interface EngineResult {
  output: string;
  source: ResponseSource;
  provider?: string;
  /** The model that actually produced an LLM response. */
  model?: string;
  latencyMs: number;
  /** The command rule that matched, if any. */
  rule?: CommandRule;
}

/** Max bytes of attacker input/output persisted per event. */
const MAX_STORED = 2_000;

/**
 * Records an interactive turn into a session's history, but only for LLM-backed
 * responses — static replies don't need conversational memory.
 */
export function appendTurn(history: ChatMessage[], input: string, result: EngineResult): void {
  if (result.source !== "llm") return;
  history.push({ role: "user", content: input });
  history.push({ role: "assistant", content: result.output });
}

/** One engine per service: matches rules, calls the LLM pool, applies hooks. */
export class DeceptionEngine {
  private readonly rules: CompiledRule[];
  private readonly hooks: Hook[];
  private readonly system: string;
  /** Human-friendly service label used in events and hook context. */
  private readonly name: string;

  constructor(
    private readonly service: ServiceConfig,
    private readonly pool: ProviderPool | undefined,
    private readonly logger: Logger,
    private readonly events: EventBus,
    private readonly metrics: Metrics,
  ) {
    this.rules = service.commands.map((rule) => ({ regex: new RegExp(rule.regex), rule }));
    this.hooks = resolveHooks(service.hooks);
    this.system = systemPrompt(service);
    this.name = service.description || service.protocol;
  }

  /** True if this service can ever produce an LLM-backed response. */
  get usesLlm(): boolean {
    return this.service.llm.enabled || this.service.commands.some((c) => c.llm);
  }

  matchRule(input: string): CommandRule | undefined {
    for (const { regex, rule } of this.rules) {
      if (regex.test(input)) return rule;
    }
    return undefined;
  }

  async handle(input: string, ctx: TurnContext, matchAgainst?: string): Promise<EngineResult> {
    const start = performance.now();
    const hookCtx: HookContext = {
      protocol: this.service.protocol,
      service: this.name,
      sessionId: ctx.sessionId,
      remoteAddr: ctx.remoteAddr,
      input,
    };

    const rule = this.matchRule(matchAgainst ?? input);
    let output = "";
    let source: ResponseSource = "error";
    let provider: string | undefined;
    let model: string | undefined;

    try {
      if (this.shouldUseLlm(rule)) {
        const completion = await this.completeWithLlm(input, ctx, hookCtx);
        output = completion.text;
        provider = completion.provider;
        model = completion.model;
        source = "llm";
      } else if (rule?.handler !== undefined) {
        output = rule.handler;
        source = "static";
      }
    } catch (error) {
      this.logger.error("engine failed to produce a response", {
        service: this.name,
        error: (error as Error).message,
      });
      this.metrics.count(METRICS.engineErrors, { protocol: this.service.protocol });
      output = "";
      source = "error";
    }

    for (const hook of this.hooks) {
      if (hook.transformResponse) output = await hook.transformResponse(output, hookCtx);
    }

    const latencyMs = Math.round(performance.now() - start);
    this.metrics.count(METRICS.events, { protocol: this.service.protocol });
    this.events.emit({
      ...this.baseEvent(ctx.remoteAddr, ctx.sessionId),
      input: truncate(input, MAX_STORED),
      output: truncate(output, MAX_STORED),
      provider,
      model,
      source,
      latencyMs,
    });
    return { output, source, provider, model, latencyMs, rule };
  }

  /** A rule with `llm: true`, or the service-level LLM fallback for an unmatched rule. */
  private shouldUseLlm(rule: CommandRule | undefined): boolean {
    if (!this.pool) return false;
    if (rule) return rule.llm === true;
    return this.service.llm.enabled;
  }

  private async completeWithLlm(
    input: string,
    ctx: TurnContext,
    hookCtx: HookContext,
  ): Promise<{ text: string; provider: string; model: string }> {
    const limit = this.service.llm.historyLimit;
    const history = limit > 0 ? ctx.history.slice(-limit) : [];
    let messages: ChatMessage[] = [
      { role: "system", content: this.system },
      ...history,
      { role: "user", content: input },
    ];
    for (const hook of this.hooks) {
      if (hook.transformPrompt) messages = await hook.transformPrompt(messages, hookCtx);
    }
    const result = await this.pool!.complete({ messages });
    this.metrics.count(METRICS.llmRequests, {
      provider: result.provider,
      protocol: this.service.protocol,
    });
    return { text: result.text, provider: result.provider, model: result.model };
  }

  recordConnect(remoteAddr: string, sessionId: string, meta?: Record<string, unknown>): void {
    this.events.emit({ ...this.baseEvent(remoteAddr, sessionId), source: "connect", meta });
  }

  recordAuth(remoteAddr: string, sessionId: string, meta: Record<string, unknown>): void {
    this.metrics.count(METRICS.authAttempts, { protocol: this.service.protocol });
    this.events.emit({
      ...this.baseEvent(remoteAddr, sessionId),
      input: String(meta.username ?? ""),
      source: "auth",
      meta,
    });
  }

  /** The common event fields shared by every event this service emits. */
  private baseEvent(
    remoteAddr: string,
    sessionId: string,
  ): Pick<
    DeceptionEvent,
    "protocol" | "service" | "address" | "remoteAddr" | "sessionId" | "input" | "output"
  > {
    return {
      protocol: this.service.protocol,
      service: this.name,
      address: this.service.address,
      remoteAddr,
      sessionId,
      input: "",
      output: "",
    };
  }
}

/** Fails fast at startup if a service references a hook that was never registered. */
export function assertHooksExist(service: ServiceConfig): void {
  for (const name of service.hooks) {
    if (!getHook(name)) throw new Error(`service references unknown hook "${name}"`);
  }
}
