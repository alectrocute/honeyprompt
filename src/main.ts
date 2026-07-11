/**
 * Command-line entrypoint. Parses arguments, loads and validates the config,
 * and either runs the deception runtime until a signal arrives or exits after
 * a one-shot command (validate/version/help).
 */
import { App } from "./app.ts";
import { ConfigError, loadConfig } from "./config/load.ts";
import { NAME, VERSION } from "./meta.ts";

const USAGE = `${NAME} ${VERSION} — modular LLM deception runtime

Usage:
  ${NAME} run [--config <path>]        Start all configured deception services (default)
  ${NAME} validate [--config <path>]   Parse and validate the config, then exit
  ${NAME} version                      Print version and exit
  ${NAME} help                         Show this help

Options:
  -c, --config <path>   Path to ${NAME}.yaml (default: ./${NAME}.yaml, or $HONEYPROMPT_CONFIG)

Environment:
  HONEYPROMPT_CONFIG    Default config path when --config is omitted
`;

interface Args {
  command: string;
  configPath: string;
}

function parseArgs(argv: string[]): Args {
  let command = "run";
  let configPath = Deno.env.get("HONEYPROMPT_CONFIG") ?? `./${NAME}.yaml`;
  const rest = [...argv];
  if (rest.length > 0 && !rest[0]!.startsWith("-")) command = rest.shift()!;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-c" || arg === "--config") {
      const next = rest[++i];
      if (!next) throw new Error("--config requires a path");
      configPath = next;
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { command, configPath };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(Deno.args);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }

  if (args.command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (args.command === "validate") {
    try {
      const cfg = await loadConfig(args.configPath);
      console.log(
        `config OK: ${cfg.services.length} service(s), ${cfg.providers.length} provider(s), ` +
          `pool strategy "${cfg.pool.strategy}", panel ${
            cfg.panel.enabled ? "enabled" : "disabled"
          }`,
      );
      return 0;
    } catch (e) {
      console.error(e instanceof ConfigError ? `invalid config: ${e.message}` : String(e));
      return 1;
    }
  }

  if (args.command !== "run") {
    console.error(`unknown command: ${args.command}`);
    console.error(USAGE);
    return 2;
  }

  let app: App;
  try {
    const cfg = await loadConfig(args.configPath);
    app = new App(cfg);
  } catch (e) {
    console.error(e instanceof ConfigError ? `invalid config: ${e.message}` : String(e));
    return 1;
  }

  const shutdown = async () => {
    await app.stop();
    Deno.exit(0);
  };
  try {
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);
  } catch {
    // Signal listeners are unavailable on some platforms; ignore.
  }

  try {
    await app.start();
  } catch (e) {
    app.logger.error("startup failed", { error: (e as Error).message });
    await app.stop();
    return 1;
  }

  // Keep the process alive; services own their own loops/servers.
  await new Promise<void>(() => {});
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
