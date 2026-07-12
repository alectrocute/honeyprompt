/**
 * An append-only, newline-delimited file writer.
 *
 * Writes are fire-and-forget from the caller's perspective but are serialized
 * internally through a promise chain, so lines never interleave and always land
 * in order. `close()` waits for the backlog to drain before releasing the
 * handle, which makes it safe to call during graceful shutdown.
 */
export class FileSink {
  private readonly file: Deno.FsFile;
  private readonly encoder = new TextEncoder();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(path: string) {
    ensureParentDir(path);
    this.file = Deno.openSync(path, { create: true, append: true, write: true });
  }

  /** Appends one line (a trailing newline is added for you). */
  writeLine(line: string): void {
    if (this.closed) return;
    const bytes = this.encoder.encode(line + "\n");
    this.tail = this.tail.then(() => writeAll(this.file, bytes)).catch(() => {});
  }

  /** Waits for queued writes to land without closing the handle. */
  async flush(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    try {
      this.file.close();
    } catch {
      // Already closed.
    }
  }
}

function ensureParentDir(path: string): void {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash > 0) Deno.mkdirSync(path.slice(0, slash), { recursive: true });
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset));
  }
}
