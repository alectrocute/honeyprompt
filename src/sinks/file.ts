import type { DeceptionEvent } from "../observability/events.ts";
import { FileSink } from "../util/file-sink.ts";
import type { Sink, SinkEnvelope } from "./types.ts";

/**
 * Appends one JSON object per line. Writes only the core {@link DeceptionEvent}
 * fields so on-disk JSONL stays backward-compatible with existing shippers.
 */
export class FileEventSink implements Sink {
  private readonly file: FileSink;

  constructor(readonly name: string, path: string) {
    this.file = new FileSink(path);
  }

  write(event: SinkEnvelope): void {
    this.file.writeLine(JSON.stringify(toDeceptionEvent(event)));
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}

function toDeceptionEvent(event: SinkEnvelope): DeceptionEvent {
  const { srcIp: _ip, srcPort: _port, ...rest } = event;
  return rest;
}
