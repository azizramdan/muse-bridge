export interface BridgeConfig {
  /** Public OpenAI API bind host. */
  host: string;
  /** Public OpenAI API port. */
  port: number;
  /** Internal consumer-hub bind host (localhost only). */
  hubHost: string;
  /** Internal consumer-hub port. */
  hubPort: number;
  /** SQLite database path, or ":memory:" for tests. */
  dbPath: string;
  /** Max active (pending + leased) rows before 429. */
  maxDepth: number;
  /** Total time a request may take before the waiter fails with 504. */
  deadlineMs: number;
  /** How long a consumer may hold a leased request before it is re-queued. */
  leaseMs: number;
  /** Heartbeat interval sent by the `consume` process. */
  heartbeatMs: number;
  /** Silence longer than this drops the consumer and re-queues its leases. */
  heartbeatTimeoutMs: number;
  /** Delivery attempts before a re-queued request expires instead. */
  maxAttempts: number;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): BridgeConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid ${key}: ${raw}`);
    }
    return parsed;
  };
  return {
    host: env.HOST ?? "127.0.0.1",
    port: num("PORT", 8765),
    hubHost: env.HUB_HOST ?? "127.0.0.1",
    hubPort: num("HUB_PORT", 8767),
    dbPath: env.DB_PATH ?? "./data/bridge.db",
    maxDepth: num("MAX_DEPTH", 64),
    deadlineMs: num("DEADLINE_MS", 240_000),
    leaseMs: num("LEASE_MS", 60_000),
    heartbeatMs: num("HEARTBEAT_MS", 10_000),
    heartbeatTimeoutMs: num("HEARTBEAT_TIMEOUT_MS", 30_000),
    maxAttempts: num("MAX_ATTEMPTS", 3),
  };
}
