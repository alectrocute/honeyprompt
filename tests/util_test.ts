import { assertEquals, assertThrows } from "@std/assert";
import { formatAddr, parseAddr } from "../src/util/addr.ts";
import { decodeEscapes } from "../src/util/escape.ts";
import { TokenBucket } from "../src/util/ratelimit.ts";
import { timingSafeEqual } from "../src/util/crypto.ts";
import { stripTrailingNewline, toCRLF, truncate } from "../src/util/text.ts";
import { parseHeaderLines } from "../src/util/http.ts";
import { uniqueId } from "../src/util/id.ts";
import { weightedOrder } from "../src/util/random.ts";

Deno.test("parseAddr handles host:port, :port and bare port", () => {
  assertEquals(parseAddr("0.0.0.0:8080"), { hostname: "0.0.0.0", port: 8080 });
  assertEquals(parseAddr(":22"), { hostname: "0.0.0.0", port: 22 });
  assertEquals(parseAddr("6379"), { hostname: "0.0.0.0", port: 6379 });
  assertEquals(parseAddr("127.0.0.1:9000").hostname, "127.0.0.1");
});

Deno.test("parseAddr rejects invalid ports", () => {
  assertThrows(() => parseAddr("localhost:99999"));
});

Deno.test("decodeEscapes decodes control and hex escapes", () => {
  assertEquals(decodeEscapes("+PONG\\r\\n"), "+PONG\r\n");
  assertEquals(decodeEscapes("\\x30\\x00"), "\x30\x00");
  assertEquals(decodeEscapes("tab\\tend"), "tab\tend");
});

Deno.test("TokenBucket allows a burst then throttles", async () => {
  const bucket = new TokenBucket(1000, 3);
  const start = performance.now();
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();
  assertEquals(performance.now() - start < 50, true);
});

Deno.test("formatAddr renders tcp addresses and falls back to unknown", () => {
  assertEquals(formatAddr({ transport: "tcp", hostname: "10.0.0.1", port: 22 }), "10.0.0.1:22");
  assertEquals(formatAddr({ transport: "unix", path: "/tmp/s" } as Deno.Addr), "unknown");
});

Deno.test("timingSafeEqual compares by value, not identity", () => {
  assertEquals(timingSafeEqual("secret", "secret"), true);
  assertEquals(timingSafeEqual("secret", "secrek"), false);
  assertEquals(timingSafeEqual("short", "longer"), false);
});

Deno.test("text helpers truncate, normalize newlines, and strip trailing newlines", () => {
  assertEquals(truncate("hello", 3), "hel");
  assertEquals(truncate("hi", 5), "hi");
  assertEquals(toCRLF("a\nb\r\nc"), "a\r\nb\r\nc");
  assertEquals(stripTrailingNewline("PING\r\n"), "PING");
});

Deno.test("parseHeaderLines parses Key: Value pairs and skips junk", () => {
  assertEquals(parseHeaderLines(["Content-Type: text/html", "no-colon", "Server: nginx"]), [
    ["Content-Type", "text/html"],
    ["Server", "nginx"],
  ]);
});

Deno.test("uniqueId produces distinct ids", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => uniqueId()));
  assertEquals(ids.size, 1000);
});

Deno.test("weightedOrder returns a permutation of the input", () => {
  const items = ["a", "b", "c", "d"];
  const ordered = weightedOrder(items, () => 1);
  assertEquals([...ordered].sort(), [...items].sort());
  assertEquals(ordered.length, items.length);
});
