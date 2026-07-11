export interface HostPort {
  hostname: string;
  port: number;
}

/** Placeholder used when a peer address can't be determined. */
export const UNKNOWN_ADDR = "unknown";

/** Parses "host:port", ":port", or "port" into a hostname/port pair. */
export function parseAddr(addr: string, defaultHost = "0.0.0.0"): HostPort {
  const trimmed = addr.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    const port = Number(trimmed);
    if (!Number.isInteger(port)) throw new Error(`invalid address "${addr}"`);
    return { hostname: defaultHost, port };
  }
  const host = trimmed.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const port = Number(trimmed.slice(lastColon + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in address "${addr}"`);
  }
  return { hostname: host === "" ? defaultHost : host, port };
}

/** Formats a Deno network address as "host:port", or "unknown" for non-IP transports. */
export function formatAddr(addr: Deno.Addr): string {
  if (addr.transport === "tcp" || addr.transport === "udp") {
    return `${addr.hostname}:${addr.port}`;
  }
  return UNKNOWN_ADDR;
}

/** The remote peer address of a connection, formatted as "host:port". */
export function remoteAddr(conn: Deno.Conn): string {
  return formatAddr(conn.remoteAddr);
}
