import { assertEquals, assertRejects } from "@std/assert";
import { buildPool, ProviderPool } from "../src/providers/pool.ts";
import { createLogger } from "../src/observability/logger.ts";
import {
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  ProviderError,
} from "../src/providers/types.ts";

const logger = createLogger("error", "text");

class StubProvider implements Provider {
  calls = 0;
  constructor(
    readonly name: string,
    readonly model = "m",
    readonly weight = 1,
    private readonly behavior: "ok" | "retryable" | "fatal" = "ok",
  ) {}
  complete(_req: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    if (this.behavior === "retryable") {
      return Promise.reject(new ProviderError("boom", this.name, true));
    }
    if (this.behavior === "fatal") {
      return Promise.reject(new ProviderError("nope", this.name, false));
    }
    return Promise.resolve({ text: `from ${this.name}`, provider: this.name, model: this.model });
  }
}

Deno.test("round-robin rotates across providers", async () => {
  const a = new StubProvider("a");
  const b = new StubProvider("b");
  const pool = new ProviderPool([a, b], { strategy: "round-robin", order: [] }, logger);
  const first = await pool.complete({ messages: [] });
  const second = await pool.complete({ messages: [] });
  assertEquals([first.provider, second.provider].sort(), ["a", "b"]);
});

Deno.test("failover skips a failing provider and uses the next", async () => {
  const bad = new StubProvider("bad", "m", 1, "retryable");
  const good = new StubProvider("good");
  const pool = new ProviderPool([bad, good], { strategy: "failover", order: [] }, logger);
  const res = await pool.complete({ messages: [] });
  assertEquals(res.provider, "good");
  assertEquals(bad.calls, 1);
});

Deno.test("a fatal (non-retryable) error stops failover", async () => {
  const fatal = new StubProvider("fatal", "m", 1, "fatal");
  const good = new StubProvider("good");
  const pool = new ProviderPool([fatal, good], { strategy: "failover", order: [] }, logger);
  await assertRejects(() => pool.complete({ messages: [] }), ProviderError, "nope");
  assertEquals(good.calls, 0);
});

Deno.test("buildPool restricts requests to the configured provider subset", async () => {
  const primary = new StubProvider("primary");
  const pinned = new StubProvider("pinned");
  const providers = new Map<string, Provider>([
    [primary.name, primary],
    [pinned.name, pinned],
  ]);

  const pool = buildPool(
    providers,
    { strategy: "round-robin", order: ["pinned"] },
    logger,
  )!;

  assertEquals(pool.names(), ["pinned"]);
  assertEquals((await pool.complete({ messages: [] })).provider, "pinned");
  assertEquals(primary.calls, 0);
  assertEquals(pinned.calls, 1);
});
