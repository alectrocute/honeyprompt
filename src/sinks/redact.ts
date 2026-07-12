import type { DeceptionEvent } from "../observability/events.ts";
import type { SinkEnvelope } from "./types.ts";

const REDACTED = "[REDACTED]";

/** Header names whose values are stripped from captured HTTP request text. */
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie)\s*:.*$/gim;

/**
 * Returns a copy of `event` safe for remote export: auth passwords and common
 * secret-bearing HTTP headers are replaced with a placeholder.
 */
export function redactEvent(event: DeceptionEvent): SinkEnvelope {
  const out: SinkEnvelope = { ...event };
  if (out.meta && "password" in out.meta) {
    out.meta = { ...out.meta, password: REDACTED };
  }
  if (out.input) out.input = redactInput(out.input);
  return out;
}

function redactInput(input: string): string {
  // HTTP request dumps are request-line + headers (+ optional body). Redact
  // sensitive header lines in place; leave the rest of the capture intact.
  return input.replace(SENSITIVE_HEADERS, (line) => {
    const colon = line.indexOf(":");
    if (colon < 0) return line;
    return `${line.slice(0, colon + 1)} ${REDACTED}`;
  });
}
