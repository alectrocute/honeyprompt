import type { PanelConfig } from "../config/schema.ts";
import { NAME } from "../meta.ts";
import type { EventBus } from "../observability/events.ts";
import type { Logger } from "../observability/logger.ts";
import type { Metrics } from "../observability/metrics.ts";
import { parseAddr } from "../util/addr.ts";
import { timingSafeEqual } from "../util/crypto.ts";
import { ContentType, jsonResponse, sseFrame } from "../util/http.ts";
import indexHtml from "./assets/index.html" with { type: "text" };
import panelCss from "./assets/panel.css" with { type: "text" };
import panelJs from "./assets/panel.js" with { type: "text" };

const DEFAULT_EVENT_LIMIT = 200;

/** Static assets served by the panel, embedded into the binary at compile time. */
const STATIC_ASSETS: Record<string, { body: string; type: string }> = {
  "/": { body: indexHtml, type: ContentType.html },
  "/index.html": { body: indexHtml, type: ContentType.html },
  "/panel.css": { body: panelCss, type: ContentType.css },
  "/panel.js": { body: panelJs, type: ContentType.javascript },
};

/**
 * Read-only monitoring panel. Serves a live dashboard, JSON export endpoints, a
 * server-sent-events stream, and Prometheus metrics. Optional HTTP basic auth
 * takes a plaintext password from config (honeyprompt handles the comparison), so no
 * manual hashing is required.
 */
export class Panel {
  private server?: Deno.HttpServer;
  private readonly ac = new AbortController();
  private readonly authHeader?: string;

  constructor(
    private readonly config: PanelConfig,
    private readonly events: EventBus,
    private readonly metrics: Metrics,
    private readonly providerNames: string[],
    private readonly logger: Logger,
    private readonly metricsEnabled: boolean,
  ) {
    if (config.auth) {
      this.authHeader = "Basic " + btoa(`${config.auth.username}:${config.auth.password}`);
    }
  }

  start(): Promise<void> {
    const { hostname, port } = parseAddr(this.config.address, "127.0.0.1");
    this.server = Deno.serve({
      hostname,
      port,
      signal: this.ac.signal,
      onListen: () => {
        this.logger.info("panel listening", {
          address: `${hostname}:${port}`,
          auth: Boolean(this.authHeader),
        });
      },
    }, (req) => this.handle(req));
    return Promise.resolve();
  }

  private unauthorized(): Response {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": `Basic realm="${NAME}", charset="UTF-8"` },
    });
  }

  private authorized(req: Request): boolean {
    if (!this.authHeader) return true;
    return timingSafeEqual(req.headers.get("authorization") ?? "", this.authHeader);
  }

  private handle(req: Request): Response {
    const url = new URL(req.url);
    const path = url.pathname;

    // Metrics stay unauthenticated by default so scrapers work; everything else is gated.
    if (path === "/metrics" && this.metricsEnabled) {
      return new Response(this.metrics.render(), {
        headers: { "content-type": ContentType.prometheus },
      });
    }
    if (path === "/healthz") return new Response("ok");

    if (!this.authorized(req)) return this.unauthorized();

    const asset = STATIC_ASSETS[path];
    if (asset) return new Response(asset.body, { headers: { "content-type": asset.type } });

    switch (path) {
      case "/api/stats": {
        const { total, byProtocol } = this.events.totals();
        return jsonResponse({ total, byProtocol, providers: this.providerNames });
      }
      case "/api/events":
        return jsonResponse(this.events.recent(this.eventLimit(url)));
      case "/api/stream":
        return this.stream();
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private eventLimit(url: URL): number {
    const limit = Number(url.searchParams.get("limit") ?? DEFAULT_EVENT_LIMIT);
    return Number.isFinite(limit) ? limit : DEFAULT_EVENT_LIMIT;
  }

  private stream(): Response {
    let unsubscribe: (() => void) | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start: (controller) => {
        unsubscribe = this.events.subscribe((event) => {
          try {
            controller.enqueue(encoder.encode(sseFrame(event)));
          } catch { /* stream closed */ }
        });
      },
      cancel: () => unsubscribe?.(),
    });
    return new Response(body, {
      headers: {
        "content-type": ContentType.eventStream,
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  async stop(): Promise<void> {
    this.ac.abort();
    await this.server?.shutdown().catch(() => {});
  }
}
