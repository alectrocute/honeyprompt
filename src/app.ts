import type { HoneypromptConfig } from "./config/schema.ts";
import { assertHooksExist, DeceptionEngine } from "./engine/engine.ts";
import { EventBus } from "./observability/events.ts";
import { createLogger, type Logger } from "./observability/logger.ts";
import { Metrics } from "./observability/metrics.ts";
import { Panel } from "./panel/panel.ts";
import { buildPool, type ProviderPool } from "./providers/pool.ts";
import { createProviders } from "./providers/registry.ts";
import type { Provider } from "./providers/types.ts";
import { createService } from "./services/registry.ts";
import type { Service } from "./services/types.ts";
import { createEventSinks } from "./sinks/registry.ts";
import type { SinkFanout } from "./sinks/fanout.ts";
import { FileSink } from "./util/file-sink.ts";

/**
 * The composition root: it wires configuration into a logger, metrics, an
 * event bus, providers, services, and the panel, then owns the order in which
 * they start and stop. Everything else in the codebase is a leaf this assembles.
 */
export class App {
  readonly logger: Logger;
  private readonly metrics = new Metrics();
  private readonly events: EventBus;
  private readonly providers: Map<string, Provider>;
  private readonly pool?: ProviderPool;
  private readonly services: Service[] = [];
  private readonly panel?: Panel;
  private readonly logSinks: FileSink[] = [];
  private readonly eventSinks?: SinkFanout;
  private stopping = false;

  constructor(private readonly config: HoneypromptConfig) {
    const logSink = config.logging.file ? this.openLogSink(config.logging.file) : undefined;
    this.logger = createLogger(
      config.logging.level,
      config.logging.format,
      logSink && ((line) => logSink.writeLine(line)),
    );

    this.eventSinks = createEventSinks(config.events, this.logger, this.metrics);
    this.events = new EventBus(
      config.events.buffer,
      this.eventSinks && ((event) => this.eventSinks!.write(event)),
    );

    this.providers = createProviders(config.providers);
    this.pool = buildPool(this.providers, config.pool, this.logger);
    this.services = config.services.map((svc) => this.buildService(svc));

    if (config.panel.enabled) {
      this.panel = new Panel(
        config.panel,
        this.events,
        this.metrics,
        [...this.providers.keys()],
        this.logger,
        config.metrics.enabled,
      );
    }
  }

  private buildService(svc: HoneypromptConfig["services"][number]): Service {
    assertHooksExist(svc);
    const pool = this.poolFor(svc);
    const engine = new DeceptionEngine(svc, pool, this.logger, this.events, this.metrics);
    if (engine.usesLlm && !pool) {
      throw new Error(
        `service "${
          svc.description || svc.protocol
        }" is LLM-backed but no providers are configured`,
      );
    }
    return createService(svc, engine, this.logger);
  }

  /**
   * Picks the provider pool a service talks to: a named pool when
   * `llm.providers` references one, its own pinned subset when it lists
   * provider names, otherwise the shared global pool.
   */
  private poolFor(svc: HoneypromptConfig["services"][number]): ProviderPool | undefined {
    if (svc.llm.providers.length === 0) return this.pool;

    const named = svc.llm.providers.length === 1
      ? this.config.pools.find((p) => p.name === svc.llm.providers[0])
      : undefined;
    if (named) {
      return buildPool(
        this.providers,
        { strategy: named.strategy, order: named.order },
        this.logger,
      );
    }

    return buildPool(
      this.providers,
      { strategy: this.config.pool.strategy, order: svc.llm.providers },
      this.logger,
    );
  }

  private openLogSink(path: string): FileSink {
    const sink = new FileSink(path);
    this.logSinks.push(sink);
    return sink;
  }

  async start(): Promise<void> {
    this.logger.info("starting honeyprompt", {
      services: this.config.services.length,
      providers: this.config.providers.length,
      poolStrategy: this.config.pool.strategy,
      eventSinks: this.eventSinks?.sinks.length ?? 0,
    });
    for (const svc of this.services) {
      try {
        await svc.start();
      } catch (e) {
        this.logger.error("failed to start service", {
          protocol: svc.config.protocol,
          address: svc.config.address,
          error: (e as Error).message,
        });
        throw e;
      }
    }
    await this.panel?.start();
    this.logger.info("honeyprompt is up", {});
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info("shutting down", {});
    await Promise.allSettled([
      ...this.services.map((s) => s.stop()),
      this.panel?.stop() ?? Promise.resolve(),
    ]);
    // Flush event sinks then operational log sinks so final events and
    // shutdown logs are captured.
    if (this.eventSinks) {
      await this.eventSinks.flush();
      await this.eventSinks.close();
    }
    await Promise.allSettled(this.logSinks.map((sink) => sink.close()));
  }
}
