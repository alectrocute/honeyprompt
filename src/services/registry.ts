import type { ServiceConfig } from "../config/schema.ts";
import type { DeceptionEngine } from "../engine/engine.ts";
import type { Logger } from "../observability/logger.ts";
import { HttpService } from "./http.ts";
import { SshService } from "./ssh.ts";
import { TcpService } from "./tcp.ts";
import { TelnetService } from "./telnet.ts";
import type { Service } from "./types.ts";

export function createService(
  config: ServiceConfig,
  engine: DeceptionEngine,
  logger: Logger,
): Service {
  switch (config.protocol) {
    case "http":
      return new HttpService(config, engine, logger);
    case "tcp":
      return new TcpService(config, engine, logger);
    case "telnet":
      return new TelnetService(config, engine, logger);
    case "ssh":
      return new SshService(config, engine, logger);
  }
}
