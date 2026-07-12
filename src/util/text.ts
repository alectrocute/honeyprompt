/** String helpers used across services, providers, and logging. */

/** Truncates `text` to at most `max` characters. */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Normalizes all line endings to CRLF, as terminal protocols expect. */
export function toCRLF(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** Strips a single trailing newline (CRLF or LF) from a line of input. */
export function stripTrailingNewline(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}
