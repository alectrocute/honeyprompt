/** Common Content-Type values, kept in one place to avoid stringly-typed drift. */
export const ContentType = {
  json: "application/json",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  javascript: "text/javascript; charset=utf-8",
  text: "text/plain; charset=utf-8",
  eventStream: "text/event-stream",
  /** Prometheus text exposition format. */
  prometheus: "text/plain; version=0.0.4",
} as const;

/** Serializes `data` as a JSON HTTP response. */
export function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": ContentType.json },
  });
}

/** Formats one server-sent-events message frame. */
export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Parses "Key: Value" header strings (as written in honeyprompt.yaml) into pairs,
 * skipping any malformed entries.
 */
export function parseHeaderLines(lines: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) pairs.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return pairs;
}
