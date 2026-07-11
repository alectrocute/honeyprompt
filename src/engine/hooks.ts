import type { ServiceProtocol } from "../config/schema.ts";
import type { ChatMessage } from "../providers/types.ts";

export interface HookContext {
  protocol: ServiceProtocol;
  service: string;
  sessionId: string;
  remoteAddr: string;
  /** The raw attacker input for this turn. */
  input: string;
}

/**
 * A hook lets you append custom logic to the prompt sent to the model and/or
 * the response returned to the attacker. Register hooks by name and reference
 * them from a service's `hooks:` list in honeyprompt.yaml.
 */
export interface Hook {
  readonly name: string;
  /** Mutate or replace the outgoing prompt messages. */
  transformPrompt?(
    messages: ChatMessage[],
    ctx: HookContext,
  ): ChatMessage[] | Promise<ChatMessage[]>;
  /** Mutate or replace the response text (LLM or static) before it is sent. */
  transformResponse?(response: string, ctx: HookContext): string | Promise<string>;
}

const registry = new Map<string, Hook>();

/** Registers a custom hook. Call this from your own module before startup. */
export function registerHook(hook: Hook): void {
  registry.set(hook.name, hook);
}

export function getHook(name: string): Hook | undefined {
  return registry.get(name);
}

export function resolveHooks(names: string[]): Hook[] {
  const hooks: Hook[] = [];
  for (const name of names) {
    const hook = registry.get(name);
    if (!hook) throw new Error(`unknown hook "${name}" referenced by a service`);
    hooks.push(hook);
  }
  return hooks;
}

// --- Built-in hooks -------------------------------------------------------

registerHook({
  name: "redact-secrets",
  transformResponse(response) {
    // Replace anything that looks like an API key/token with a plausible fake,
    // so the honeypot never leaks real credentials injected via env or config.
    return response.replace(/\b(sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g, "sk-REDACTED");
  },
});

registerHook({
  name: "slow-typist",
  // No-op transform; exists as a template showing the hook shape.
  transformResponse(response) {
    return response;
  },
});
