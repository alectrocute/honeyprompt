/** Anything with a synchronous `close()` — sockets, listeners, streams. */
export interface Closable {
  close(): void;
}

/** Closes a resource, swallowing the error if it is already closed. */
export function closeQuietly(resource: Closable | undefined | null): void {
  if (!resource) return;
  try {
    resource.close();
  } catch {
    // Already closed or closing; nothing to do.
  }
}

/**
 * Runs `fn` with an inactivity deadline: if it hasn't settled within `ms`,
 * `onTimeout` fires (typically closing the connection, which unblocks the
 * pending read). The timer is always cleared once `fn` settles.
 */
export async function withDeadline<T>(
  ms: number,
  onTimeout: () => void,
  fn: () => Promise<T>,
): Promise<T> {
  const timer = setTimeout(onTimeout, ms);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
  }
}
