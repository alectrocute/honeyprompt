import type { ServiceConfig } from "../config/schema.ts";
import type { DeceptionEngine } from "../engine/engine.ts";
import type { Logger } from "../observability/logger.ts";
import { formatAddr, parseAddr } from "../util/addr.ts";
import { ContentType, parseHeaderLines } from "../util/http.ts";
import { uniqueId } from "../util/id.ts";
import { truncate } from "../util/text.ts";
import type { Service } from "./types.ts";

/** Largest request body slice forwarded to the model as context. */
const MAX_BODY_CONTEXT = 4096;

export class HttpService implements Service {
  private server?: Deno.HttpServer;
  private readonly ac = new AbortController();

  constructor(
    readonly config: ServiceConfig,
    private readonly engine: DeceptionEngine,
    private readonly logger: Logger,
  ) {}

  start(): Promise<void> {
    const { hostname, port } = parseAddr(this.config.address);
    const handler = (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> =>
      this.handle(req, info);

    const onListen = () => {
      this.logger.info("service listening", {
        protocol: "http",
        address: `${hostname}:${port}`,
        tls: Boolean(this.config.tls),
      });
    };

    const base = { hostname, port, signal: this.ac.signal, onListen };
    this.server = this.config.tls
      ? Deno.serve({
        ...base,
        cert: Deno.readTextFileSync(this.config.tls.certFile),
        key: Deno.readTextFileSync(this.config.tls.keyFile),
      }, handler)
      : Deno.serve(base, handler);
    return Promise.resolve();
  }

  private async handle(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
    const url = new URL(req.url);
    const remoteAddr = formatAddr(info.remoteAddr);
    const sessionId = uniqueId();
    const body = await this.readBoundedBody(req);

    // Rules match against "METHOD /path?query", falling back to the bare path.
    const requestLine = `${req.method} ${url.pathname}${url.search}`;
    const target = this.engine.matchRule(requestLine) ? requestLine : url.pathname + url.search;
    const result = await this.engine.handle(
      this.buildInput(req, url, body),
      { sessionId, remoteAddr, history: [] },
      target,
    );

    if (result.source === "error") {
      return new Response("Internal Server Error", { status: 500, headers: this.headers() });
    }
    return new Response(result.output, {
      status: result.rule?.statusCode ?? 200,
      headers: this.headers(result.rule?.headers),
    });
  }

  /** Builds response headers from a rule, filling in sensible defaults. */
  private headers(ruleHeaders?: string[]): Headers {
    const headers = new Headers(parseHeaderLines(ruleHeaders ?? []));
    if (!headers.has("content-type")) headers.set("content-type", ContentType.html);
    if (this.config.serverVersion && !headers.has("server")) {
      headers.set("server", this.config.serverVersion);
    }
    return headers;
  }

  private buildInput(req: Request, url: URL, body: string): string {
    const headerLines = [...req.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    const parts = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`, headerLines];
    if (body) parts.push("", body);
    return parts.join("\n");
  }

  /**
   * Reads at most MAX_BODY_CONTEXT bytes of the request body. A honeypot faces
   * hostile clients, so we never buffer an unbounded upload just to log it.
   */
  private async readBoundedBody(req: Request): Promise<string> {
    if (!req.body) return "";
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < MAX_BODY_CONTEXT) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } catch {
      // Truncated or aborted upload; use whatever we managed to read.
    } finally {
      await reader.cancel().catch(() => {});
    }
    return truncate(new TextDecoder().decode(concatChunks(chunks)), MAX_BODY_CONTEXT);
  }

  async stop(): Promise<void> {
    this.ac.abort();
    await this.server?.shutdown().catch(() => {});
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
