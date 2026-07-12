import type { Logger } from "../observability/logger.ts";
import type { Metrics } from "../observability/metrics.ts";
import { ContentType } from "../util/http.ts";
import { HttpBatchSink, sinkHttpError } from "./http-batch.ts";
import type { HttpBatchOptions, SinkEnvelope } from "./types.ts";

export interface CrowdStrikeSinkOptions extends HttpBatchOptions {
  name: string;
  /** HEC ingest URL from the Falcon NG-SIEM data connector. */
  url: string;
  /** Environment variable holding the HEC API token. */
  tokenEnv: string;
  sourcetype: string;
  source: string;
  host: string;
}

/**
 * CrowdStrike Falcon Next-Gen SIEM / LogScale HTTP Event Collector adapter.
 * Sends Splunk-compatible HEC JSON events with Bearer token auth.
 */
export class CrowdStrikeHecSink extends HttpBatchSink {
  readonly name: string;
  private readonly url: string;
  private readonly tokenEnv: string;
  private readonly sourcetype: string;
  private readonly source: string;
  private readonly host: string;

  constructor(opts: CrowdStrikeSinkOptions, logger: Logger, metrics?: Metrics) {
    super(opts, logger, metrics);
    this.name = opts.name;
    this.url = normalizeHecUrl(opts.url);
    this.tokenEnv = opts.tokenEnv;
    this.sourcetype = opts.sourcetype;
    this.source = opts.source;
    this.host = opts.host;
  }

  protected override async sendBatch(batch: SinkEnvelope[], signal: AbortSignal): Promise<void> {
    const token = Deno.env.get(this.tokenEnv);
    if (!token) {
      throw new Error(`sink "${this.name}" is missing HEC token (env ${this.tokenEnv})`);
    }

    const body = batch.map((event) =>
      JSON.stringify({
        time: hecTime(event.ts),
        host: this.host,
        source: this.source,
        sourcetype: this.sourcetype,
        event,
      })
    ).join("");

    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": ContentType.json,
      },
      body,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw sinkHttpError(this.name, res.status, text);
    }
    await res.arrayBuffer().catch(() => {});
  }
}

/** Appends `/services/collector` when the connector URL has no path. */
export function normalizeHecUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      parsed.pathname = "/services/collector";
      return parsed.toString().replace(/\/+$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/** HEC `time` is unix seconds (fractional allowed). */
export function hecTime(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : Date.now() / 1000;
}
