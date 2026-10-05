import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "./config";

export class NoConsumersError extends Error {
  constructor() {
    super("no Muse consumer attached");
    this.name = "NoConsumersError";
  }
}

export class QueueFullError extends Error {
  constructor() {
    super("Muse bridge busy, try again in a bit");
    this.name = "QueueFullError";
  }
}

export class DeadlineExceededError extends Error {
  constructor() {
    super("Muse did not answer in time");
    this.name = "DeadlineExceededError";
  }
}

/** The HTTP client went away before an answer arrived. */
export class ClientDisconnectedError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientDisconnectedError";
  }
}

/** Anything a consumer session can write to (a WebSocket in production). */
export interface ConsumerOut {
  send(msg: Record<string, unknown>): void;
}

interface Consumer {
  id: string;
  out: ConsumerOut;
  inflight: Set<string>;
  lastBeat: number;
}

interface Waiter {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}

interface RequestRow {
  id: string;
  received_at: number;
  deadline: number;
  payload: string;
  status: string;
  consumer_id: string | null;
  attempts: number;
  lease_expires_at: number | null;
  answer: string | null;
}

/**
 * Competing-consumers queue over SQLite.
 *
 * Exactly-once hinges on two atomic statements (single SQLite writer):
 *   claim:  UPDATE ... WHERE id=? AND status='pending'
 *   answer: UPDATE ... WHERE id=? AND status='leased' AND consumer_id=?
 * A rowcount of 0 means someone else won the race — discard silently.
 */
export class Hub {
  private consumers = new Map<string, Consumer>();
  private waiters = new Map<string, Waiter>();
  private reaper: Timer | null = null;

  constructor(
    readonly db: Database,
    readonly cfg: BridgeConfig,
  ) {}

  get consumerCount(): number {
    return this.consumers.size;
  }

  /** Active rows: pending + leased. */
  get depth(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS c FROM requests WHERE status IN ('pending','leased')")
      .get() as { c: number };
    return row.c;
  }

  /**
   * Enqueue a request and wait for its answer.
   *
   * `opts.onId` reports the generated request id synchronously (so callers
   * can abort it); `opts.signal` aborts the request when the client goes away.
   */
  submit(
    payload: unknown,
    opts: { onId?: (id: string) => void; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (this.consumers.size === 0) {
      return Promise.reject(new NoConsumersError());
    }
    if (this.depth >= this.cfg.maxDepth) {
      return Promise.reject(new QueueFullError());
    }
    const id = randomUUID();
    const now = Date.now();
    const deadline = now + this.cfg.deadlineMs;
    this.db
      .query(
        "INSERT INTO requests (id, received_at, deadline, payload, status) VALUES (?, ?, ?, ?, 'pending')",
      )
      .run(id, now, deadline, JSON.stringify(payload));
    const result = new Promise<string>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });
    opts.onId?.(id);
    if (opts.signal) {
      if (opts.signal.aborted) {
        queueMicrotask(() => this.abort(id));
      } else {
        opts.signal.addEventListener("abort", () => this.abort(id), { once: true });
      }
    }
    this.dispatch();
    return result;
  }

  attach(id: string, out: ConsumerOut): void {
    if (this.consumers.has(id)) this.detach(id);
    this.consumers.set(id, { id, out, inflight: new Set(), lastBeat: Date.now() });
    this.dispatch();
  }

  detach(id: string): void {
    const consumer = this.consumers.get(id);
    if (!consumer) return;
    this.consumers.delete(id);
    const rows = this.db
      .query(
        "SELECT id, attempts, deadline FROM requests WHERE status='leased' AND consumer_id = ?",
      )
      .all(id) as Pick<RequestRow, "id" | "attempts" | "deadline">[];
    for (const row of rows) {
      this.resolveLeaseFailure(row.id, row.attempts, row.deadline);
    }
    this.dispatch();
  }

  handleMessage(consumerId: string, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "heartbeat": {
        const consumer = this.consumers.get(consumerId);
        if (consumer) consumer.lastBeat = Date.now();
        return;
      }
      case "answer": {
        this.acceptAnswer(consumerId, String(msg.id), String(msg.content ?? ""));
        return;
      }
      case "giveup": {
        this.giveup(consumerId, String(msg.id));
        return;
      }
      default:
        return; // unknown/forwarded messages are ignored
    }
  }

  /** Abandon a waiter (client disconnected): fail it and drop the row. */
  abort(id: string): void {
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter.reject(new ClientDisconnectedError());
    }
    this.db
      .query("DELETE FROM requests WHERE id = ? AND status='pending'")
      .run(id);
    this.db
      .query("UPDATE requests SET status='expired' WHERE id = ? AND status='leased'")
      .run(id);
  }

  startReaper(intervalMs = 1_000): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.tick(), intervalMs);
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }

  /** One maintenance pass: dead consumers, expired leases, deadlines, purge, dispatch. */
  tick(now = Date.now()): void {
    for (const consumer of [...this.consumers.values()]) {
      if (now - consumer.lastBeat > this.cfg.heartbeatTimeoutMs) {
        this.detach(consumer.id);
      }
    }

    const leaseRows = this.db
      .query(
        "SELECT id, attempts, deadline, consumer_id FROM requests WHERE status='leased' AND lease_expires_at < ?",
      )
      .all(now) as Pick<RequestRow, "id" | "attempts" | "deadline" | "consumer_id">[];
    for (const row of leaseRows) {
      if (row.consumer_id) {
        this.consumers.get(row.consumer_id)?.inflight.delete(row.id);
      }
      this.resolveLeaseFailure(row.id, row.attempts, row.deadline);
    }

    const deadlineRows = this.db
      .query(
        "SELECT id FROM requests WHERE status IN ('pending','leased') AND deadline < ?",
      )
      .all(now) as { id: string }[];
    for (const row of deadlineRows) {
      this.expire(row.id, new DeadlineExceededError());
    }

    this.db
      .query(
        "DELETE FROM requests WHERE status IN ('done','expired') AND received_at < ?",
      )
      .run(now - 600_000);

    this.dispatch();
  }

  close(): void {
    this.stopReaper();
    for (const consumer of [...this.consumers.keys()]) this.detach(consumer);
    for (const [, waiter] of this.waiters) waiter.reject(new NoConsumersError());
    this.waiters.clear();
  }

  // ---- internals ----------------------------------------------------------

  /** Push one request to each idle consumer, oldest pending first.
   *  Consumers rotate to the back of the registry after each delivery so
   *  dispatch is round-robin across Muse servers instead of favoring the
   *  first-attached one. */
  private dispatch(): void {
    for (const consumer of [...this.consumers.values()]) {
      if (consumer.inflight.size > 0) continue;
      const row = this.claimNext(consumer.id);
      if (!row) break; // no pending work left for anyone
      consumer.inflight.add(row.id);
      consumer.out.send({
        type: "request",
        id: row.id,
        payload: JSON.parse(row.payload),
        deadline: row.deadline,
      });
      this.consumers.delete(consumer.id);
      this.consumers.set(consumer.id, consumer);
    }
  }

  /** Atomically claim the oldest pending row for a consumer. */
  private claimNext(consumerId: string): RequestRow | null {
    const oldest = this.db
      .query(
        "SELECT * FROM requests WHERE status='pending' ORDER BY received_at ASC LIMIT 1",
      )
      .get() as RequestRow | null;
    if (!oldest) return null;
    const res = this.db
      .query(
        "UPDATE requests SET status='leased', consumer_id=?, lease_expires_at=?, attempts=attempts+1 WHERE id=? AND status='pending'",
      )
      .run(consumerId, Date.now() + this.cfg.leaseMs, oldest.id);
    if (res.changes === 0) return null;
    return { ...oldest, status: "leased", consumer_id: consumerId };
  }

  private acceptAnswer(consumerId: string, id: string, content: string): void {
    const res = this.db
      .query(
        "UPDATE requests SET status='done', answer=? WHERE id=? AND status='leased' AND consumer_id=?",
      )
      .run(content, id, consumerId);
    this.consumers.get(consumerId)?.inflight.delete(id);
    if (res.changes === 1) {
      const waiter = this.waiters.get(id);
      if (waiter) {
        this.waiters.delete(id);
        waiter.resolve(content);
      }
    }
    this.dispatch();
  }

  private giveup(consumerId: string, id: string): void {
    this.consumers.get(consumerId)?.inflight.delete(id);
    const row = this.db
      .query("SELECT id, attempts, deadline, status, consumer_id FROM requests WHERE id = ?")
      .get(id) as RequestRow | undefined;
    if (
      row &&
      row.status === "leased" &&
      row.consumer_id === consumerId
    ) {
      this.resolveLeaseFailure(row.id, row.attempts, row.deadline);
    }
    this.dispatch();
  }

  /** Re-queue a lease the consumer gave up or outlived; expire at deadline/max attempts. */
  private resolveLeaseFailure(id: string, attempts: number, deadline: number): void {
    if (Date.now() >= deadline || attempts >= this.cfg.maxAttempts) {
      this.expire(id, new DeadlineExceededError());
      return;
    }
    this.db
      .query(
        "UPDATE requests SET status='pending', consumer_id=NULL, lease_expires_at=NULL WHERE id=? AND status='leased'",
      )
      .run(id);
  }

  private expire(id: string, err: Error): void {
    this.db
      .query("UPDATE requests SET status='expired' WHERE id=? AND status IN ('pending','leased')")
      .run(id);
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter.reject(err);
    }
  }
}
