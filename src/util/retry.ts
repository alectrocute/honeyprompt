export interface RetryOptions {
  retries: number;
  /** Base delay in ms; grows exponentially with jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Return true to retry on a given error. Defaults to always. */
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 200;
  const max = opts.maxDelayMs ?? 5_000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const canRetry = attempt < opts.retries && (opts.shouldRetry?.(error) ?? true);
      if (!canRetry) break;
      const backoff = Math.min(max, base * 2 ** attempt);
      const delay = backoff / 2 + Math.random() * (backoff / 2);
      opts.onRetry?.(attempt + 1, error, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
