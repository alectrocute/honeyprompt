import type { DeceptionEvent } from "../observability/events.ts";
import type { SinkEnvelope } from "./types.ts";

/**
 * Splits `remoteAddr` (`host:port` or `[ipv6]:port`) into `srcIp` / `srcPort`
 * when parseable. Leaves the original `remoteAddr` field untouched.
 */
export function normalizeEvent(event: DeceptionEvent): SinkEnvelope {
  const out: SinkEnvelope = { ...event };
  const parsed = parseRemoteAddr(event.remoteAddr);
  if (parsed) {
    out.srcIp = parsed.ip;
    out.srcPort = parsed.port;
  }
  return out;
}

function parseRemoteAddr(addr: string): { ip: string; port: number } | undefined {
  if (!addr || addr === "unknown") return undefined;

  if (addr.startsWith("[")) {
    const close = addr.indexOf("]");
    if (close < 0) return undefined;
    const ip = addr.slice(1, close);
    const portPart = addr.slice(close + 1);
    if (!portPart.startsWith(":")) return { ip, port: 0 };
    const port = Number(portPart.slice(1));
    if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
    return { ip, port };
  }

  const lastColon = addr.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const ip = addr.slice(0, lastColon);
  const port = Number(addr.slice(lastColon + 1));
  if (!ip || !Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return { ip, port };
}
