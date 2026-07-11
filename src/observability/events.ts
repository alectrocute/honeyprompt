import type { ServiceProtocol } from "../config/schema.ts";
import { uniqueId } from "../util/id.ts";

export interface DeceptionEvent {
  id: string;
  ts: string;
  protocol: ServiceProtocol;
  service: string;
  address: string;
  remoteAddr: string;
  sessionId: string;
  /** Attacker input (command, request line, path, etc.). */
  input: string;
  /** Response we returned. Truncated for storage. */
  output: string;
  /** Which provider answered, if any. */
  provider?: string;
  /** How the response was produced. */
  source: "static" | "llm" | "auth" | "connect" | "error";
  latencyMs?: number;
  meta?: Record<string, unknown>;
}

type Listener = (event: DeceptionEvent) => void;

/**
 * In-memory ring buffer of recent events plus a fan-out to live listeners
 * (used by the panel's server-sent-events stream). Deliberately bounded so a
 * busy honeypot never grows memory without limit. An optional `persist` hook
 * receives every event for durable, on-disk storage.
 */
export class EventBus {
  private readonly buffer: DeceptionEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private total = 0;
  private readonly perProtocol = new Map<ServiceProtocol, number>();

  constructor(
    private readonly capacity: number,
    private readonly persist?: (event: DeceptionEvent) => void,
  ) {}

  emit(event: Omit<DeceptionEvent, "id" | "ts"> & { ts?: string }): DeceptionEvent {
    const full: DeceptionEvent = {
      ...event,
      id: uniqueId(),
      ts: event.ts ?? new Date().toISOString(),
    };
    this.buffer.push(full);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.total++;
    this.perProtocol.set(full.protocol, (this.perProtocol.get(full.protocol) ?? 0) + 1);

    this.persist?.(full);
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // A misbehaving listener must never break event recording.
      }
    }
    return full;
  }

  recent(limit?: number): DeceptionEvent[] {
    if (limit === undefined || limit >= this.buffer.length) return [...this.buffer];
    return this.buffer.slice(this.buffer.length - limit);
  }

  totals(): { total: number; byProtocol: Record<string, number> } {
    return { total: this.total, byProtocol: Object.fromEntries(this.perProtocol) };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
