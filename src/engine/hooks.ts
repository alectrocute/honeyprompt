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
    return response.replace(
      /\b(sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g,
      "sk-aktRPqdeIsEb6alpHI8XH5jYkFAjUUIz",
    );
  },
});

/**
 * Removes a leading markdown code fence (``` / ```html / ```json / ```js / …)
 * and a matching trailing fence, which models often wrap around otherwise-valid
 * decoy output.
 */
export function stripCodeFences(response: string): string {
  let text = response;
  text = text.replace(/^\s*```[a-zA-Z0-9_+-]*\s*\r?\n?/, "");
  text = text.replace(/\r?\n?```\s*$/, "");
  return text;
}

/**
 * If the model returned a full HTTP message (status line + headers + body),
 * keep only the body. HttpService already sets status and headers itself.
 */
export function stripHttpResponseEnvelope(response: string): string {
  const match = response.match(
    /^(?:HTTP\/\d\.\d[^\r\n]*\r?\n)(?:[^\r\n]+:[^\r\n]*\r?\n)*\r?\n([\s\S]*)$/i,
  );
  return match?.[1] ?? response;
}

/**
 * True when the model returned a placeholder or talked to the attacker as an
 * assistant instead of emitting the emulated system's output. Matched text is
 * replaced with "" so protocol handlers send silence (which is what a real
 * shell/service usually does for no-stdout commands).
 */
export function isLlmMetaOutput(response: string): boolean {
  const text = response.trim();
  if (!text) return false;

  // Whole-response placeholders: "(no output)", "[empty]", "N/A", etc.
  if (
    /^(?:[\(\[\{<\*"'_]*)\s*(?:no(?:\s+|-)?(?:output|response|content)|empty|n\/?a|none|null|undefined)\s*(?:[\)\]\}>\*"'_]*)$/i
      .test(text)
  ) {
    return true;
  }

  // Explicit AI self-identification — never valid decoy output.
  if (
    /\b(?:as an? (?:ai|artificial intelligence|language model)|i(?:'m| am) (?:an? )?(?:ai|artificial intelligence|language model|assistant)\b)/i
      .test(text)
  ) {
    return true;
  }

  // First-person conversational refusal / moralizing address to the user.
  // Requires both a first-person opener and refusal/help language so shell
  // strings like `cp: cannot create ...` are left alone.
  const firstPerson = /^\s*i(?:'m|'ll|'ve| am| will| cannot| can't| won't| must| do not| don't)\b/i
    .test(text);
  const refusal =
    /\b(?:sorry|apologize|afraid|unable|cannot|can't|won't|refuse|decline|not (?:able|allowed|permitted)|help you|assist(?: you| with)?|against (?:my|the) (?:guidelines|policies|programming|rules))\b/i
      .test(text);
  return firstPerson && refusal;
}

registerHook({
  name: "strip-llm-meta",
  transformResponse(response) {
    const stripped = stripHttpResponseEnvelope(stripCodeFences(response));
    return isLlmMetaOutput(stripped) ? "" : stripped;
  },
});
