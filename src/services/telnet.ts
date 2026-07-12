import type { ServiceConfig } from "../config/schema.ts";
import { appendTurn, type DeceptionEngine } from "../engine/engine.ts";
import type { Logger } from "../observability/logger.ts";
import type { ChatMessage } from "../providers/types.ts";
import { parseAddr, remoteAddr } from "../util/addr.ts";
import { uniqueId } from "../util/id.ts";
import { closeQuietly, withDeadline } from "../util/io.ts";
import type { Service } from "./types.ts";

/** Telnet negotiation bytes (RFC 854). */
const TELNET = {
  IAC: 255, // Interpret As Command — introduces a negotiation sequence.
  SB: 250, // Subnegotiation Begin.
  SE: 240, // Subnegotiation End.
} as const;

const READ_BUFFER_BYTES = 4096;
const MAX_LINE_BYTES = 8192;

/** Removes inline Telnet IAC negotiation sequences, leaving only user input. */
function stripIac(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== TELNET.IAC) {
      out.push(bytes[i]!);
      continue;
    }
    if (bytes[i + 1] === TELNET.SB) {
      i += 2;
      while (i < bytes.length && !(bytes[i] === TELNET.IAC && bytes[i + 1] === TELNET.SE)) i++;
      i++;
    } else {
      // WILL/WONT/DO/DONT and friends are three-byte sequences.
      i += 2;
    }
  }
  return new Uint8Array(out);
}

export class TelnetService implements Service {
  private listener?: Deno.Listener;
  private closed = false;
  private readonly conns = new Set<Deno.Conn>();
  private readonly encoder = new TextEncoder();

  constructor(
    readonly config: ServiceConfig,
    private readonly engine: DeceptionEngine,
    private readonly logger: Logger,
  ) {}

  start(): Promise<void> {
    const { hostname, port } = parseAddr(this.config.address);
    this.listener = Deno.listen({ hostname, port });
    this.logger.info("service listening", { protocol: "telnet", address: `${hostname}:${port}` });
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

  private send(conn: Deno.Conn, text: string): Promise<void> {
    return conn.write(this.encoder.encode(text)).then(() => {}).catch(() => {});
  }

  private async handleConn(conn: Deno.Conn): Promise<void> {
    const addr = remoteAddr(conn);
    const sessionId = uniqueId();
    const history: ChatMessage[] = [];
    const host = this.config.serverName ?? "server";
    this.engine.recordConnect(addr, sessionId);

    if (!await this.authenticate(conn, addr, sessionId, host)) return;

    const prompt = `\r\n${host}> `;
    await this.send(conn, prompt);
    while (!this.closed) {
      const line = await this.readLine(conn);
      if (line === null) break;
      if (line.trim().length === 0) {
        await this.send(conn, prompt);
        continue;
      }
      const result = await this.engine.handle(line, { sessionId, remoteAddr: addr, history });
      appendTurn(history, line, result);
      const body = result.output.length ? `\r\n${result.output}` : "";
      await this.send(conn, `${body}${prompt}`);
    }
  }

  /** Runs the login prompt flow. Returns false if the client should be disconnected. */
  private async authenticate(
    conn: Deno.Conn,
    addr: string,
    sessionId: string,
    host: string,
  ): Promise<boolean> {
    if (!this.config.passwordRegex) return true;
    const passwordRegex = new RegExp(this.config.passwordRegex);

    await this.send(conn, `\r\n${host} login: `);
    const username = await this.readLine(conn);
    await this.send(conn, "Password: ");
    const password = await this.readLine(conn);
    if (username === null || password === null) return false;

    const ok = passwordRegex.test(password);
    this.engine.recordAuth(addr, sessionId, { username, password, success: ok });
    if (!ok) {
      await this.send(conn, "\r\nLogin incorrect\r\n");
      return false;
    }
    await this.send(conn, "\r\nWelcome.\r\n");
    return true;
  }

  private async readLine(conn: Deno.Conn): Promise<string | null> {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(READ_BUFFER_BYTES);
    let acc = "";
    while (acc.length < MAX_LINE_BYTES) {
      const n = await withDeadline(
        this.config.deadlineSeconds * 1000,
        () => closeQuietly(conn),
        async () => {
          try {
            return await conn.read(buf);
          } catch {
            return null;
          }
        },
      );
      if (n === null || n <= 0) return acc.length ? acc : null;
      acc += decoder.decode(stripIac(buf.subarray(0, n)));
      const newline = acc.indexOf("\n");
      if (newline !== -1) return acc.slice(0, newline).replace(/\r$/, "");
    }
    return acc;
  }

  stop(): Promise<void> {
    this.closed = true;
    closeQuietly(this.listener);
    for (const conn of this.conns) closeQuietly(conn);
    this.conns.clear();
    return Promise.resolve();
  }
}
