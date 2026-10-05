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

function startTestBridge(over: Partial<BridgeConfig> = {}, reaperMs = 50): RunningBridge {
  return startBridge(makeConfig(over), { reaperMs });
}

/** A fake Muse consumer speaking the real hub protocol over WebSocket. */
class TestConsumer {
  requests: Array<{ id: string; payload: any; deadline: number }> = [];
  private pending: Array<(req: any) => void> = [];
  private ws!: WebSocket;

  static async connect(hubPort: number, id: string): Promise<TestConsumer> {
    const c = new TestConsumer();
    c.ws = new WebSocket(`ws://127.0.0.1:${hubPort}`);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = (e) => reject(e);
    });
    c.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "request") {
        c.requests.push(msg);
        const waiter = c.pending.shift();
        waiter?.(msg);
      }
    };
    c.ws.send(JSON.stringify({ type: "hello", consumer: id }));
    return c;
  }

  nextRequest(): Promise<{ id: string; payload: any; deadline: number }> {
    const queued = this.requests.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  answer(id: string, content: string): void {
    this.ws.send(JSON.stringify({ type: "answer", id, content }));
  }

  close(): void {
    this.ws.close();
  }
}

function chatBody(over: Record<string, unknown> = {}) {
  return {
    model: "muse",
    messages: [{ role: "user", content: "Halo, siapa kamu?" }],
    ...over,
  };
}

const probeBody = {
  model: "muse",
  max_tokens: 1024,
  stream: false,
  messages: [
    { role: "system", content: "test" },
    { role: "user", content: "hi" },
  ],
};

async function post(port: number, body: unknown, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

describe("openai surface", () => {
  test("GET /health reports ok with zero consumers", async () => {
    const b = startTestBridge();
    try {
      const res = await fetch(`http://127.0.0.1:${b.publicPort}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, consumers: 0, depth: 0 });
    } finally {
      await b.close();
    }
  });

  test("GET /v1/models lists the muse model", async () => {
    const b = startTestBridge();
    try {
      const res = await fetch(`http://127.0.0.1:${b.publicPort}/v1/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((m) => m.id)).toContain("muse");
    } finally {
      await b.close();
    }
  });

  test("malformed JSON returns 400", async () => {
    const b = startTestBridge();
    try {
      const res = await post(b.publicPort, "{nope");
      expect(res.status).toBe(400);
    } finally {
      await b.close();
    }
  });

  test("POST with no consumer returns 503 fail-fast", async () => {
    const b = startTestBridge();
    try {
      const res = await post(b.publicPort, chatBody());
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("no Muse consumer");
    } finally {
      await b.close();
    }
  });

  test("dashboard probe answers instantly without any consumer", async () => {
    const b = startTestBridge();
    try {
      const res = await post(b.publicPort, probeBody);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        object: string;
        choices: Array<{ message: { role: string; content: string } }>;
      };
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    } finally {
      await b.close();
    }
  });

  test("round trip returns a well-formed chat.completion", async () => {
    const b = startTestBridge();
    try {
      const c = await TestConsumer.connect(b.hubPort, "muse-1");

      const pending = post(b.publicPort, chatBody({ max_tokens: 100 }));
      const req = await c.nextRequest();
      expect(req.payload.messages[0].content).toBe("Halo, siapa kamu?");
      c.answer(req.id, "Halo! Saya Muse.");

      const res = await pending;
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id.startsWith("chatcmpl-")).toBe(true);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe("muse");
      expect(body.choices[0].message).toEqual({ role: "assistant", content: "Halo! Saya Muse." });
      expect(body.choices[0].finish_reason).toBe("stop");
      expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

      c.close();
    } finally {
      await b.close();
    }
  });

  test("the requested model is echoed back", async () => {
    const b = startTestBridge();
    try {
      const c = await TestConsumer.connect(b.hubPort, "muse-1");
      const pending = post(b.publicPort, chatBody({ model: "muse/custom" }));
      const req = await c.nextRequest();
      c.answer(req.id, "ok");
      const res = await pending;
      const body = (await res.json()) as { model: string };
      expect(body.model).toBe("muse/custom");
      c.close();
    } finally {
      await b.close();
    }
  });

  test("streaming returns SSE with chunks and [DONE]", async () => {
    const b = startTestBridge();
    try {
      const c = await TestConsumer.connect(b.hubPort, "muse-1");

      const pending = post(b.publicPort, chatBody({ stream: true }));
      const req = await c.nextRequest();
      c.answer(req.id, "jawaban stream");

      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");

      const text = await res.text();
      expect(text).toContain(": connected");
      expect(text).toContain('"object":"chat.completion.chunk"');
      expect(text).toContain('"content":"jawaban stream"');
      expect(text).toContain('"finish_reason":"stop"');
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

      c.close();
    } finally {
      await b.close();
    }
  });

  test("active depth at maxDepth returns 429", async () => {
    const b = startTestBridge({ maxDepth: 1 });
    try {
      const c = await TestConsumer.connect(b.hubPort, "muse-1");

      const first = post(b.publicPort, chatBody());
      const firstReq = await c.nextRequest(); // leased, unanswered -> depth = 1

      const second = await post(b.publicPort, chatBody());
      expect(second.status).toBe(429);

      c.answer(firstReq.id, "cleanup");
      expect((await first).status).toBe(200);
      c.close();
    } finally {
      await b.close();
    }
  });

  test("deadline exceeded returns 504", async () => {
    const b = startTestBridge({ deadlineMs: 150 });
    try {
      const c = await TestConsumer.connect(b.hubPort, "muse-1");
      const res = await post(b.publicPort, chatBody());
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("in time");
      c.close();
    } finally {
      await b.close();
    }
  });

  test("consumer disconnect mid-request: another consumer answers the re-queued request", async () => {
    const b = startTestBridge();
    try {
      const c1 = await TestConsumer.connect(b.hubPort, "muse-1");
      const pending = post(b.publicPort, chatBody());
      const req = await c1.nextRequest();

      c1.close(); // tunnel drops mid-flight

      const c2 = await TestConsumer.connect(b.hubPort, "muse-2");
      const requeued = await c2.nextRequest();
      expect(requeued.id).toBe(req.id);
      c2.answer(requeued.id, "saved by muse-2");

      const res = await pending;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0].message.content).toBe("saved by muse-2");
      c2.close();
    } finally {
      await b.close();
    }
  });

  test("client abort expires the row and a late consumer answer is discarded", async () => {
    const b = startTestBridge();
    try {
      const c = await TestConsumer.connect(b.hubPort, "muse-1");
      const controller = new AbortController();
      const pending = post(b.publicPort, chatBody(), { signal: controller.signal });
      const req = await c.nextRequest();

      controller.abort();
      await pending.catch(() => {});

      expect(b.hub.depth).toBe(0);

      c.answer(req.id, "too late"); // must not crash or resurrect the row
      await Bun.sleep(20);
      expect(b.hub.depth).toBe(0);

      c.close();
    } finally {
      await b.close();
    }
  });
});
