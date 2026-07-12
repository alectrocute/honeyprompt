// deno-lint-ignore-file no-explicit-any
import ssh2 from "ssh2";
import type { ServiceConfig } from "../config/schema.ts";
import { appendTurn, type DeceptionEngine } from "../engine/engine.ts";
import type { Logger } from "../observability/logger.ts";
import type { ChatMessage } from "../providers/types.ts";
import { parseAddr, UNKNOWN_ADDR } from "../util/addr.ts";
import { uniqueId } from "../util/id.ts";
import { toCRLF } from "../util/text.ts";
import type { Service } from "./types.ts";

const { Server, utils } = ssh2 as any;

const HOST_KEY_TYPE = "ed25519";
/** ssh2 prepends "SSH-2.0-", so this is just the software string. */
const DEFAULT_IDENT = "OpenSSH_9.6";
const DEFAULT_HOST = "server";
const SHELL_USER = "root";

/** ASCII control codes handled by the interactive line editor. */
const KEY = {
  CTRL_C: 3,
  BACKSPACE: 8,
  ENTER_CR: 13,
  DELETE: 127,
  FIRST_PRINTABLE: 32,
} as const;

/**
 * Interactive SSH deception service backed by ssh2. Accepts logins per the
 * configured password regex, then presents a shell whose command output is
 * produced by the deception engine (static rules or the LLM pool).
 */
export class SshService implements Service {
  private server?: any;

  constructor(
    readonly config: ServiceConfig,
    private readonly engine: DeceptionEngine,
    private readonly logger: Logger,
  ) {}

  start(): Promise<void> {
    const { hostname, port } = parseAddr(this.config.address);
    const hostKey = this.config.hostKeyFile
      ? Deno.readTextFileSync(this.config.hostKeyFile)
      : utils.generateKeyPairSync(HOST_KEY_TYPE).private;
    const ident = this.config.serverVersion ?? DEFAULT_IDENT;

    this.server = new Server(
      { hostKeys: [hostKey], ident },
      (client: any) => this.onClient(client),
    );

    return new Promise((resolve) => {
      this.server.listen(port, hostname, () => {
        this.logger.info("service listening", { protocol: "ssh", address: `${hostname}:${port}` });
        resolve();
      });
    });
  }

  private onClient(client: any): void {
    const sessionId = uniqueId();
    const history: ChatMessage[] = [];
    let remoteAddr = UNKNOWN_ADDR;
    const passwordRegex = this.config.passwordRegex
      ? new RegExp(this.config.passwordRegex)
      : undefined;

    client.on("error", (e: Error) => this.logger.debug("ssh client error", { error: e.message }));

    client.on("authentication", (ctx: any) => {
      remoteAddr = clientAddr(client);
      if (ctx.method !== "password") {
        // Advertise password auth so clients retry with a password.
        ctx.reject(["password"]);
        return;
      }
      const ok = passwordRegex ? passwordRegex.test(ctx.password) : true;
      this.engine.recordAuth(remoteAddr, sessionId, {
        username: ctx.username,
        password: ctx.password,
        method: "password",
        success: ok,
      });
      if (ok) ctx.accept();
      else ctx.reject(["password"]);
    });

    client.on("ready", () => {
      this.engine.recordConnect(remoteAddr, sessionId);
      client.on(
        "session",
        (accept: any) => this.onSession(accept(), remoteAddr, sessionId, history),
      );
    });
  }

  private onSession(
    session: any,
    remoteAddr: string,
    sessionId: string,
    history: ChatMessage[],
  ): void {
    session.on("pty", (accept: any) => accept && accept());
    session.on("window-change", (accept: any) => accept && accept());

    session.on("exec", async (accept: any, _reject: any, info: any) => {
      const stream = accept();
      const result = await this.engine.handle(info.command, { sessionId, remoteAddr, history });
      if (result.output) stream.write(toCRLF(result.output) + "\r\n");
      stream.exit(0);
      stream.end();
    });

    session.on("shell", (accept: any) => {
      this.runShell(accept(), remoteAddr, sessionId, history);
    });
  }

  private runShell(
    stream: any,
    remoteAddr: string,
    sessionId: string,
    history: ChatMessage[],
  ): void {
    const host = this.config.serverName ?? DEFAULT_HOST;
    const prompt = `${SHELL_USER}@${host}:~# `;
    let line = "";
    let idle = this.resetIdle(stream);

    stream.write(prompt);

    stream.on("data", async (chunk: Buffer) => {
      clearTimeout(idle);
      idle = this.resetIdle(stream);
      for (const ch of chunk.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          stream.write("\r\n");
          const cmd = line.trim();
          line = "";
          if (cmd === "exit" || cmd === "logout") {
            stream.write("logout\r\n");
            stream.exit(0);
            stream.end();
            return;
          }
          if (cmd.length > 0) {
            await this.runCommand(stream, cmd, { sessionId, remoteAddr, history });
          }
          stream.write(prompt);
        } else if (code === KEY.DELETE || code === KEY.BACKSPACE) {
          if (line.length > 0) {
            line = line.slice(0, -1);
            stream.write("\b \b");
          }
        } else if (code === KEY.CTRL_C) {
          line = "";
          stream.write("^C\r\n" + prompt);
        } else if (code >= KEY.FIRST_PRINTABLE) {
          line += ch;
          stream.write(ch);
        }
      }
    });

    stream.on("close", () => clearTimeout(idle));
  }

  private async runCommand(
    stream: any,
    cmd: string,
    ctx: { sessionId: string; remoteAddr: string; history: ChatMessage[] },
  ): Promise<void> {
    const result = await this.engine.handle(cmd, ctx);
    appendTurn(ctx.history, cmd, result);
    if (result.output) stream.write(toCRLF(result.output) + "\r\n");
  }

  private resetIdle(stream: any): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      try {
        stream.end();
      } catch { /* already closed */ }
    }, this.config.deadlineSeconds * 1000);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      try {
        this.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

/** ssh2 exposes the peer only via its underlying (private) socket. */
function clientAddr(client: any): string {
  const sock = client?._sock;
  return sock?.remoteAddress ? `${sock.remoteAddress}:${sock.remotePort}` : UNKNOWN_ADDR;
}
