import { assertEquals } from "@std/assert";
import { FileSink } from "../src/util/file-sink.ts";
import { EventBus } from "../src/observability/events.ts";

Deno.test("FileSink appends newline-delimited lines and flushes on close", async () => {
  const path = await Deno.makeTempFile();
  const sink = new FileSink(path);
  sink.writeLine("first");
  sink.writeLine("second");
  await sink.close();

  assertEquals(await Deno.readTextFile(path), "first\nsecond\n");
  await Deno.remove(path);
});

Deno.test("FileSink creates missing parent directories", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/nested/deep/events.jsonl`;
  const sink = new FileSink(path);
  sink.writeLine("ok");
  await sink.close();

  assertEquals(await Deno.readTextFile(path), "ok\n");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("EventBus forwards every event to its persist hook", () => {
  const persisted: string[] = [];
  const bus = new EventBus(10, (e) => persisted.push(e.source));
  bus.emit({
    protocol: "tcp",
    service: "redis",
    address: ":6379",
    remoteAddr: "1.2.3.4:5",
    sessionId: "s",
    input: "PING",
    output: "+PONG",
    source: "static",
  });
  assertEquals(persisted, ["static"]);
});

Deno.test("EventBus ring buffer never exceeds capacity", () => {
  const bus = new EventBus(3);
  for (let i = 0; i < 10; i++) {
    bus.emit({
      protocol: "http",
      service: "web",
      address: ":80",
      remoteAddr: "x",
      sessionId: "s",
      input: String(i),
      output: "",
      source: "static",
    });
  }
  const recent = bus.recent();
  assertEquals(recent.length, 3);
  assertEquals(recent.map((e) => e.input), ["7", "8", "9"]);
  assertEquals(bus.totals().total, 10);
});
