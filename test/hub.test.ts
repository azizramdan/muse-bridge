import { describe, expect, test } from "bun:test";
import {
  ClientDisconnectedError,
  DeadlineExceededError,
  Hub,
  NoConsumersError,
  QueueFullError,
} from "../src/hub";
import { createSchema, openDb } from "../src/db";
import type { BridgeConfig } from "../src/config";

function makeConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    hubHost: "127.0.0.1",
    hubPort: 0,
    dbPath: ":memory:",
    maxDepth: 5,
    deadlineMs: 5_000,
    leaseMs: 1_000,
    heartbeatMs: 100,
    heartbeatTimeoutMs: 400,
    maxAttempts: 3,
    ...over,
  };
}

function makeHub(over: Partial<BridgeConfig> = {}) {
  const cfg = makeConfig(over);
  const db = openDb(cfg.dbPath);
  createSchema(db);
  return { hub: new Hub(db, cfg), db, cfg };
}

class FakeConsumer {
  received: Array<Record<string, unknown>> = [];
  constructor(readonly id: string) {}
  send(msg: Record<string, unknown>) {
    this.received.push(msg);
  }
  get requests() {
    return this.received.filter((m) => m.type === "request");
  }
  get lastRequest() {
    return this.requests[this.requests.length - 1];
  }
}

const payload = { model: "muse", messages: [{ role: "user", content: "hi" }] };

describe("hub dispatch", () => {
  test("submit dispatches the request to an idle attached consumer and resolves with its answer", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);

    await Bun.sleep(0); // let dispatch run
    expect(a.requests).toHaveLength(1);
    expect(a.lastRequest!.payload).toEqual(payload);
    expect(a.lastRequest!.deadline).toBeGreaterThan(Date.now());

    hub.handleMessage("a", {
      type: "answer",
      id: a.lastRequest!.id,
      content: "jawaban",
    });

    expect(await result).toBe("jawaban");
  });

  test("rejects submit with NoConsumersError when no consumer is attached", async () => {
    const { hub } = makeHub();
    await expect(hub.submit(payload)).rejects.toBeInstanceOf(NoConsumersError);
  });

  test("rejects with QueueFullError when active depth reaches maxDepth", async () => {
    const { hub } = makeHub({ maxDepth: 1 });
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const first = hub.submit(payload);
    await Bun.sleep(0);
    expect(a.requests).toHaveLength(1);

    // first request is leased and unanswered: depth = 1 = maxDepth
    await expect(hub.submit(payload)).rejects.toBeInstanceOf(QueueFullError);

    hub.handleMessage("a", { type: "answer", id: a.lastRequest!.id, content: "x" });
    await first;
  });

  test("after the last consumer detaches, new submits fail fast but the in-flight request survives for reconnect", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);

    hub.detach(a.id);
    expect(hub.consumerCount).toBe(0);

    // fail-fast applies to NEW requests while zero consumers are attached
    await expect(hub.submit(payload)).rejects.toBeInstanceOf(NoConsumersError);

    // the in-flight request was re-queued and resolves when a consumer returns
    const b = new FakeConsumer("b");
    hub.attach(b.id, b);
    await Bun.sleep(0);
    expect(b.requests).toHaveLength(1);

    hub.handleMessage("b", { type: "answer", id: b.lastRequest!.id, content: "late-but-ok" });
    expect(await result).toBe("late-but-ok");
  });
});

describe("hub exactly-once", () => {
  test("a stale answer from a re-queued request's original consumer is discarded", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    const reqId = a.lastRequest!.id as string;

    // consumer A goes silent -> heartbeat timeout -> re-queue
    await Bun.sleep(450);
    hub.tick();

    const b = new FakeConsumer("b");
    hub.attach(b.id, b);
    await Bun.sleep(0);
    expect(b.requests).toHaveLength(1);

    hub.handleMessage("b", { type: "answer", id: reqId, content: "jawaban-b" });
    expect(await result).toBe("jawaban-b");

    // A finally answers the same request late: must be discarded, not blow up
    hub.handleMessage("a", { type: "answer", id: reqId, content: "jawaban-a" });

    // and B's answer is the one stored
    const row = hub["db"]
      .query("SELECT status, answer FROM requests WHERE id = ?")
      .get(reqId) as { status: string; answer: string };
    expect(row.status).toBe("done");
    expect(row.answer).toBe("jawaban-b");
  });

  test("two answers for the same request resolve the waiter exactly once with the first content", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    const reqId = a.lastRequest!.id as string;

    hub.handleMessage("a", { type: "answer", id: reqId, content: "first" });
    hub.handleMessage("a", { type: "answer", id: reqId, content: "second" });

    expect(await result).toBe("first");
    const row = hub["db"]
      .query("SELECT answer FROM requests WHERE id = ?")
      .get(reqId) as { answer: string };
    expect(row.answer).toBe("first");
  });
});

describe("hub queueing", () => {
  test("a busy consumer does not receive a second request; the next idle consumer pulls the oldest pending one", async () => {
    const { hub } = makeHub({ maxDepth: 10 });
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const first = hub.submit(payload);
    await Bun.sleep(0);
    expect(a.requests).toHaveLength(1); // A is now busy

    const second = hub.submit({ ...payload, messages: [{ role: "user", content: "second" }] });
    const third = hub.submit({ ...payload, messages: [{ role: "user", content: "third" }] });
    await Bun.sleep(0);
    expect(a.requests).toHaveLength(1); // still only one: one in-flight per consumer

    const b = new FakeConsumer("b");
    hub.attach(b.id, b);
    await Bun.sleep(0);
    expect(b.requests).toHaveLength(1);
    // oldest pending first (FIFO)
    expect(b.lastRequest!.payload.messages[0].content).toBe("second");

    hub.handleMessage("b", { type: "answer", id: b.lastRequest!.id, content: "b1" });
    await Bun.sleep(0);
    expect(b.requests).toHaveLength(2); // B freed -> pulls the third
    expect(b.lastRequest!.payload.messages[0].content).toBe("third");

    hub.handleMessage("a", { type: "answer", id: a.lastRequest!.id, content: "a1" });
    hub.handleMessage("b", { type: "answer", id: b.lastRequest!.id, content: "b2" });

    expect(await first).toBe("a1");
    expect(await second).toBe("b1");
    expect(await third).toBe("b2");
  });
});

describe("hub recovery", () => {
  test("expired deadline rejects the waiter with DeadlineExceededError", async () => {
    const { hub } = makeHub({ deadlineMs: 80 });
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    expect(a.requests).toHaveLength(1);

    await Bun.sleep(120);
    hub.tick();

    await expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
    const row = hub["db"]
      .query("SELECT status FROM requests WHERE id = ?")
      .get(a.lastRequest!.id) as { status: string };
    expect(row.status).toBe("expired");
  });

  test("expired lease re-queues the request and the other consumer picks it up", async () => {
    const { hub } = makeHub({ leaseMs: 60, deadlineMs: 5_000 });
    const a = new FakeConsumer("a");
    const b = new FakeConsumer("b");
    hub.attach(a.id, a);
    hub.attach(b.id, b);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    expect(a.requests).toHaveLength(1); // A claimed first (round-robin)
    const reqId = a.lastRequest!.id as string;

    await Bun.sleep(100);
    hub.tick(); // lease expired, A never answered -> requeue + dispatch

    expect(b.requests).toHaveLength(1);

    hub.handleMessage("b", { type: "answer", id: reqId, content: "recovered" });
    expect(await result).toBe("recovered");
  });

  test("giveup from the owning consumer re-queues the request to the other consumer", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    const b = new FakeConsumer("b");
    hub.attach(a.id, a);
    hub.attach(b.id, b);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    expect(a.requests).toHaveLength(1);
    const reqId = a.lastRequest!.id as string;

    hub.handleMessage("a", { type: "giveup", id: reqId });
    await Bun.sleep(0);
    expect(b.requests).toHaveLength(1);

    hub.handleMessage("b", { type: "answer", id: reqId, content: "ok" });
    expect(await result).toBe("ok");
  });

  test("giveup at maxAttempts expires the request instead of re-queueing", async () => {
    const { hub } = makeHub({ maxAttempts: 1, deadlineMs: 5_000 });
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    const reqId = a.lastRequest!.id as string;

    hub.handleMessage("a", { type: "giveup", id: reqId });

    await expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
    const row = hub["db"]
      .query("SELECT status FROM requests WHERE id = ?")
      .get(reqId) as { status: string };
    expect(row.status).toBe("expired");
  });

  test("giveup from a non-owning consumer is ignored", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    const reqId = a.lastRequest!.id as string;

    hub.handleMessage("rando", { type: "giveup", id: reqId });

    hub.handleMessage("a", { type: "answer", id: reqId, content: "still-a" });
    expect(await result).toBe("still-a");
  });
});

describe("hub abort", () => {
  test("abort rejects the waiter, expires the row, and discards a late answer", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const result = hub.submit(payload);
    await Bun.sleep(0);
    const reqId = a.lastRequest!.id as string;

    hub.abort(reqId);
    await expect(result).rejects.toBeInstanceOf(ClientDisconnectedError);
    expect(hub.depth).toBe(0);

    hub.handleMessage("a", { type: "answer", id: reqId, content: "late" });
    expect(hub.depth).toBe(0);
    const row = hub.db.query("SELECT status FROM requests WHERE id = ?").get(reqId) as {
      status: string;
    };
    expect(row.status).toBe("expired");
  });

  test("submit honors an AbortSignal", async () => {
    const { hub } = makeHub();
    const a = new FakeConsumer("a");
    hub.attach(a.id, a);

    const controller = new AbortController();
    const result = hub.submit(payload, { signal: controller.signal });
    await Bun.sleep(0);
    expect(hub.depth).toBe(1);

    controller.abort();
    await expect(result).rejects.toBeInstanceOf(ClientDisconnectedError);
    expect(hub.depth).toBe(0);
  });
});
