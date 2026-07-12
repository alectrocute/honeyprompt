import type { Logger } from "../observability/logger.ts";
import type { Metrics } from "../observability/metrics.ts";
import { ContentType } from "../util/http.ts";
import { HttpBatchSink, sinkHttpError } from "./http-batch.ts";
import type { HttpBatchOptions, SinkEnvelope } from "./types.ts";

export type WebhookFormat = "ndjson" | "json-array";

export interface WebhookSinkOptions extends HttpBatchOptions {
  name: string;
  url: string;
  headers?: Record<string, string>;
  format: WebhookFormat;
}

/**
 * Vendor-neutral HTTP sink: POSTs batched envelopes as NDJSON or a JSON array.
 * Suitable for generic webhooks, SOAR intake, or any collector that accepts JSON.
 */
export class WebhookSink extends HttpBatchSink {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly format: WebhookFormat;

  constructor(opts: WebhookSinkOptions, logger: Logger, metrics?: Metrics) {
    super(opts, logger, metrics);
    this.name = opts.name;
    this.url = opts.url;
    this.headers = { ...(opts.headers ?? {}) };
    this.format = opts.format;
  }

  protected override async sendBatch(batch: SinkEnvelope[], signal: AbortSignal): Promise<void> {
    const { body, contentType } = encodeBatch(batch, this.format);
    const headers: Record<string, string> = {
      "content-type": contentType,
      ...this.headers,
    };
    const res = await fetch(this.url, { method: "POST", headers, body, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw sinkHttpError(this.name, res.status, text);
    }
    await res.arrayBuffer().catch(() => {});
  }
}

function encodeBatch(
  batch: SinkEnvelope[],
  format: WebhookFormat,
): { body: string; contentType: string } {
  if (format === "json-array") {
    return { body: JSON.stringify(batch), contentType: ContentType.json };
  }
  return {
    body: batch.map((e) => JSON.stringify(e)).join("\n") + "\n",
    contentType: ContentType.text,
  };
}
