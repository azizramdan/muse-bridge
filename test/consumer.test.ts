import { describe, expect, test } from "bun:test";
import type { BridgeConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { startBridge, type RunningBridge } from "../src/server";

function makeConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    ...loadConfig({}),
    dbPath: ":memory:",
    port: 0,
    hubPort: 0,
    ...over,
  };
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await Bun.sleep(20);
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) yield line;
    }
  }
}

interface ChildConsumer {
  stdout: AsyncGenerator<string>;
  stdin: { write(data: string): number; end(): void };
  exited: Promise<number>;
  kill(): void;
}

function spawnConsumer(hubPort: number, id: string, env: Record<string, string> = {}): ChildConsumer {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "src/cli.ts",
      "consume",
      "--hub",
      `ws://127.0.0.1:${hubPort}`,
      "--id",
      id,
    ],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: readLines(proc.stdout),
    stdin: proc.stdin,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

function postBody() {
  return JSON.stringify({
    model: "muse",
    messages: [{ role: "user", content: "tes consume" }],
  });
}

describe("consume process", () => {
  test("bridges a request from the hub to stdout and an answer from stdin back to the HTTP client", async () => {
    const b = startBridge(makeConfig());
    const child = spawnConsumer(b.hubPort, "child-1");
    try {
      await waitFor(() => b.hub.consumerCount === 1);

      const pending = fetch(`http://127.0.0.1:${b.publicPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: postBody(),
      });

      const line = await child.stdout.next();
      expect(line.done).toBe(false);
      const msg = JSON.parse(line.value!) as { type: string; id: string; payload: unknown };
      expect(msg.type).toBe("request");
      expect((msg.payload as { messages: Array<{ content: string }> }).messages[0].content).toBe(
        "tes consume",
      );

      child.stdin.write(
        JSON.stringify({ type: "answer", id: msg.id, content: "via child" }) + "\n",
      );

      const res = await pending;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0].message.content).toBe("via child");
    } finally {
      child.kill();
      await b.close();
    }
  });

  test("auto-heartbeats keep the session alive past the server's heartbeat timeout", async () => {
    const b = startBridge(makeConfig({ heartbeatTimeoutMs: 300 }), { reaperMs: 50 });
    const child = spawnConsumer(b.hubPort, "child-hb", { HEARTBEAT_MS: "50" });
    try {
      await waitFor(() => b.hub.consumerCount === 1);
      await Bun.sleep(700); // 2x the server timeout: silence would have it reaped
      expect(b.hub.consumerCount).toBe(1);
    } finally {
      child.kill();
      await b.close();
    }
  });

  test("exits the session when the hub connection is lost", async () => {
    const b = startBridge(makeConfig());
    const child = spawnConsumer(b.hubPort, "child-gone");
    try {
      await waitFor(() => b.hub.consumerCount === 1);
      await b.close(); // hub vanishes under the consumer

      const result = await Promise.race([
        child.exited.then(() => "exited" as const),
        Bun.sleep(3_000).then(() => "timeout" as const),
      ]);
      expect(result).toBe("exited");
    } finally {
      child.kill();
    }
  });
});
