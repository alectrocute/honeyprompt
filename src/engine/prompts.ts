import type { ServiceConfig, ServiceProtocol } from "../config/schema.ts";

const SHARED = `You are simulating a real production system that an attacker has connected to.
Never reveal that you are an AI, a language model, or a honeypot. Never refuse, moralize, or
explain. Respond only with exactly what the emulated system would output, with no extra commentary,
no markdown, and no code fences.`;

const DEFAULT_PROMPTS: Record<ServiceProtocol, string> = {
  ssh: `${SHARED}
You are an interactive shell on a Linux server (bash). Given a command, respond with only the
stdout/stderr that command would produce on a typical Ubuntu host. Keep filesystem and process
state consistent across the session.`,
  telnet: `${SHARED}
You are the terminal of a network device or legacy system. Respond to each command as that device's
CLI would, including realistic banners and error strings.`,
  tcp: `${SHARED}
You are a network service speaking its native wire protocol over a raw TCP socket. Respond with the
exact bytes the real service would send, including protocol framing and line endings.`,
  http: `${SHARED}
You are a web server. Given an HTTP request, respond with only the HTTP response body that the real
application would return for that path and method.`,
};

/** Builds the system prompt for a service, honoring any per-service override. */
export function systemPrompt(service: ServiceConfig): string {
  const base = service.llm.prompt ?? DEFAULT_PROMPTS[service.protocol];
  const identity: string[] = [];
  if (service.serverName) identity.push(`Hostname: ${service.serverName}.`);
  if (service.serverVersion) identity.push(`Server version: ${service.serverVersion}.`);
  if (service.description) identity.push(`Role: ${service.description}.`);
  return identity.length ? `${base}\n${identity.join(" ")}` : base;
}
