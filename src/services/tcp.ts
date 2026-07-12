import type { ServiceConfig } from "../config/schema.ts";
import type { DeceptionEngine } from "../engine/engine.ts";
import type { Logger } from "../observability/logger.ts";
import type { ChatMessage } from "../providers/types.ts";
import { appendTurn } from "../engine/engine.ts";
import { parseAddr, remoteAddr } from "../util/addr.ts";
import { decodeEscapes } from "../util/escape.ts";
import { uniqueId } from "../util/id.ts";
import { closeQuietly, withDeadline } from "../util/io.ts";
import { stripTrailingNewline } from "../util/text.ts";
import type { Service } from "./types.ts";

const READ_BUFFER_BYTES = 64 * 1024;

/** Generic raw-TCP deception service: banner + per-chunk request/response. */
export class TcpService implements Service {
  private listener?: Deno.Listener;
  private closed = false;
  private readonly conns = new Set<Deno.Conn>();

  constructor(
    readonly config: ServiceConfig,
    private readonly engine: DeceptionEngine,
    private readonly logger: Logger,
  ) {}

  start(): Promise<void> {
    const { hostname, port } = parseAddr(this.config.address);
    this.listener = Deno.listen({ hostname, port });
    this.logger.info("service listening", {
      protocol: this.config.protocol,
      address: `${hostname}:${port}`,
    });
    this.acceptLoop();
    return Promise.resolve();
  }

  private async acceptLoop(): Promise<void> {
    if (!this.listener) return;
    for await (const conn of this.listener) {
      this.conns.add(conn);
      this.handleConn(conn)
        .catch((e) => this.logger.debug("connection error", { error: (e as Error).message }))
        .finally(() => {
          this.conns.delete(conn);
          closeQuietly(conn);
        });
    }
  }

  private async handleConn(conn: Deno.Conn): Promise<void> {
    const addr = remoteAddr(conn);
    const sessionId = uniqueId();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const history: ChatMessage[] = [];

    this.engine.recordConnect(addr, sessionId);

    if (this.config.banner) {
      await conn.write(encoder.encode(decodeEscapes(this.config.banner))).catch(() => {});
    }

    const buf = new Uint8Array(READ_BUFFER_BYTES);
    while (!this.closed) {
      const n = await this.readWithDeadline(conn, buf);
      if (n === null || n <= 0) break;
      const input = stripTrailingNewline(decoder.decode(buf.subarray(0, n)));
      if (input.length === 0) continue;

      const result = await this.engine.handle(input, { sessionId, remoteAddr: addr, history });
      appendTurn(history, input, result);
      if (result.output.length > 0) {
        await conn.write(encoder.encode(result.output)).catch(() => {});
      }
    }
  }

  private readWithDeadline(conn: Deno.Conn, buf: Uint8Array): Promise<number | null> {
    return withDeadline(this.config.deadlineSeconds * 1000, () => closeQuietly(conn), async () => {
      try {
        return await conn.read(buf);
      } catch {
        return null;
      }
    });
  }

  stop(): Promise<void> {
    this.closed = true;
    closeQuietly(this.listener);
    for (const conn of this.conns) closeQuietly(conn);
    this.conns.clear();
    return Promise.resolve();
  }
}
