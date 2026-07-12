import { assertEquals, assertRejects } from "@std/assert";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { GoogleProvider } from "../src/providers/google.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai_compat.ts";
import { ProviderError } from "../src/providers/types.ts";
import type { ProviderConfig } from "../src/config/schema.ts";

function baseCfg(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: "test",
    type: "openai-compatible",
    model: "test-model",
    weight: 1,
    timeoutMs: 1000,
    retries: 0,
    ...overrides,
  };
}

async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, handler);
  const port = (server.addr as Deno.NetAddr).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    ac.abort();
    await server.finished.catch(() => {});
  }
}

async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

Deno.test("OpenAI-compatible provider parses a chat completion", async () => {
  await withServer(
    () => Response.json({ choices: [{ message: { role: "assistant", content: "hello there" } }] }),
    async (baseUrl) => {
      const p = new OpenAICompatibleProvider(baseCfg({ baseUrl }));
      const res = await p.complete({ messages: [{ role: "user", content: "hi" }] });
      assertEquals(res.text, "hello there");
      assertEquals(res.provider, "test");
    },
  );
});

Deno.test("Anthropic provider translates messages and parses text blocks", async () => {
  await withEnv("HONEYPROMPT_TEST_ANTHROPIC_KEY", "anthropic-secret", async () => {
    await withServer(
      async (request) => {
        assertEquals(request.url.endsWith("/v1/v1/messages"), true);
        assertEquals(request.headers.get("x-api-key"), "anthropic-secret");
        const body = await request.json();
        assertEquals(body.system, "system prompt");
        assertEquals(body.messages, [{ role: "user", content: "hello" }]);
        assertEquals(body.max_tokens, 256);
        return Response.json({
          content: [{ type: "text", text: "hello " }, { type: "text", text: "there" }],
        });
      },
      async (baseUrl) => {
        const provider = new AnthropicProvider(baseCfg({
          type: "anthropic",
          baseUrl,
          apiKeyEnv: "HONEYPROMPT_TEST_ANTHROPIC_KEY",
          maxTokens: 256,
        }));
        const result = await provider.complete({
          messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "hello" },
          ],
        });
        assertEquals(result.text, "hello there");
      },
    );
  });
});

Deno.test("Google provider translates roles and parses candidate parts", async () => {
  await withEnv("HONEYPROMPT_TEST_GOOGLE_KEY", "google-secret", async () => {
    await withServer(
      async (request) => {
        assertEquals(request.url.endsWith("/v1/models/test-model:generateContent"), true);
        assertEquals(request.headers.get("x-goog-api-key"), "google-secret");
        const body = await request.json();
        assertEquals(body.systemInstruction, { parts: [{ text: "system prompt" }] });
        assertEquals(body.contents, [
          { role: "user", parts: [{ text: "hello" }] },
          { role: "model", parts: [{ text: "hi" }] },
        ]);
        return Response.json({
          candidates: [{ content: { parts: [{ text: "hello " }, { text: "there" }] } }],
        });
      },
      async (baseUrl) => {
        const provider = new GoogleProvider(baseCfg({
          type: "google",
          baseUrl,
          apiKeyEnv: "HONEYPROMPT_TEST_GOOGLE_KEY",
        }));
        const result = await provider.complete({
          messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
        });
        assertEquals(result.text, "hello there");
      },
    );
  });
});

Deno.test("provider surfaces HTTP 500 as a retryable ProviderError", async () => {
  await withServer(
    () => new Response("upstream boom", { status: 500 }),
    async (baseUrl) => {
      const p = new OpenAICompatibleProvider(baseCfg({ baseUrl }));
      const err = await assertRejects(
        () => p.complete({ messages: [] }),
        ProviderError,
      );
      assertEquals(err.retryable, true);
      assertEquals(err.status, 500);
    },
  );
});

Deno.test("provider retries then succeeds", async () => {
  let hits = 0;
  await withServer(
    () => {
      hits++;
      if (hits === 1) return new Response("try again", { status: 503 });
      return Response.json({ choices: [{ message: { content: "ok now" } }] });
    },
    async (baseUrl) => {
      const p = new OpenAICompatibleProvider(baseCfg({ baseUrl, retries: 2 }));
      const res = await p.complete({ messages: [] });
      assertEquals(res.text, "ok now");
      assertEquals(hits, 2);
    },
  );
});
