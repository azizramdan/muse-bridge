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
    maxDepth: 100,
    ...over,
  };
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

/** Fake consumer that instantly answers every request with an echo of its marker. */
class EchoConsumer {
  private ws!: WebSocket;

  static async connect(hubPort: number, id: string): Promise<EchoConsumer> {
    const c = new EchoConsumer();
    c.ws = new WebSocket(`ws://127.0.0.1:${hubPort}`);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = reject;
    });
    c.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type !== "request") return;
      const marker = msg.payload.messages[msg.payload.messages.length - 1].content;
      c.ws.send(JSON.stringify({ type: "answer", id: msg.id, content: `echo:${marker}` }));
    };
    c.ws.send(JSON.stringify({ type: "hello", consumer: id }));
    return c;
  }

  close(): void {
    this.ws.close();
  }
}

describe("load", () => {
  test("a burst across multiple consumers is answered exactly once each", async () => {
    const CONSUMERS = 3;
    const REQUESTS = 40;
    const b = startBridge(makeConfig());
    try {
      const consumers = await Promise.all(
        Array.from({ length: CONSUMERS }, (_, i) => EchoConsumer.connect(b.hubPort, `m-${i}`)),
      );
      await waitFor(() => b.hub.consumerCount === CONSUMERS);

      const results = await Promise.all(
        Array.from({ length: REQUESTS }, (_, n) =>
          fetch(`http://127.0.0.1:${b.publicPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "muse",
              messages: [{ role: "user", content: `req-${n}` }],
            }),
          }).then(async (res) => {
            const body = (await res.json()) as {
              choices: Array<{ message: { content: string } }>;
            };
            return { status: res.status, content: body.choices[0].message.content };
          }),
        ),
      );

      // every request succeeded...
      expect(results.every((r) => r.status === 200)).toBe(true);

      // ...and each answer matches its own request: no duplicates, no cross-talk
      for (let n = 0; n < REQUESTS; n++) {
        expect(results[n].content).toBe(`echo:req-${n}`);
      }

      // exactly REQUESTS rows settled as done (no leftover pending/leased)
      const done = b.hub.db
        .query("SELECT COUNT(*) AS c FROM requests WHERE status='done'")
        .get() as { c: number };
      expect(done.c).toBe(REQUESTS);
      expect(b.hub.depth).toBe(0);

      for (const c of consumers) c.close();
    } finally {
      await b.close();
    }
  });
});
