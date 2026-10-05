# Muse Bridge — Design

Date: 2026-10-05
Status: approved (conversational review)

## Goal

An OpenAI-compatible bridge that answers `/v1/chat/completions` requests using
Muse agents as the inference backend, with:

- **Latency first** — sub-second handoff (no polling); total time ≈ model
  generation time.
- **Scale to fit** — correct at any queue depth; backpressure (429) instead of
  a fixed target; N Muse servers share one queue.
- **Exactly-once** — a request is delivered once and its answer accepted once,
  even with racing consumers.
- **Fail fast** — no consumer tunnel attached → 503 immediately. No cron/file
  fallback.
- **Bun + TypeScript + `bun:sqlite`** — single runtime, native driver.

## Topology

```
Client / 9Router ──HTTP :8765──▶ bun serve (one process)
                                    │  bun:sqlite (WAL)
                                    │  consumer registry + waiters
                                    │
      Muse #1 ──ssh──▶ bun consume ─┤  (localhost WS :8767)
      Muse #2 ──ssh──▶ bun consume ─┤  one request in flight per consumer
      Muse #N ──ssh──▶ consume ─────┘
```

- `serve` exposes the public OpenAI API on `:8765` and an internal consumer
  hub on `127.0.0.1:8767` (WebSocket, NDJSON-equivalent JSON messages).
- `consume` runs on the VPS as the remote command of an outbound SSH session
  started by a Muse agent. It bridges the WS hub to its own stdin/stdout, so
  the Muse agent reads request lines from the SSH session and writes answer
  lines to it. One Muse agent run = one long-lived session.
- Dispatch: push to the least-busy connected consumer; an idle consumer also
  pulls the oldest pending row. Zero consumers → 503. Active rows
  (`pending`+`leased`) ≥ `MAX_DEPTH` → 429.

## Schema (`bun:sqlite`, WAL)

```sql
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,   -- epoch ms
  deadline INTEGER NOT NULL,      -- epoch ms; waiter fails with 504 after this
  payload TEXT NOT NULL,          -- raw OpenAI request JSON
  status TEXT NOT NULL,           -- pending | leased | done | expired
  consumer_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  answer TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status, received_at);
```

The DB is the source of truth for persistence and the exactly-once latch; the
in-memory hub holds live waiters and consumer sessions.

## Exactly-once

Every answer is accepted through one atomic statement:

```sql
UPDATE requests
   SET status = 'done', answer = ?
 WHERE id = ? AND status = 'leased' AND consumer_id = ?;
```

- Rowcount 1 → the answer wins; resolve the HTTP waiter.
- Rowcount 0 → late/duplicate answer from a re-queued or raced request;
  silently discarded (consumer still clears it from its in-flight set).

Delivery re-queue uses the same pattern (`WHERE status='leased' AND
consumer_id=?`), so a consumer can never double-claim, and two consumers can
never both hold the same request.

## Wire protocol (JSON messages over the WS / SSH stdio bridge)

```
consume → serve : {"type":"hello","consumer":"muse-1"}
serve  → consume: {"type":"request","id":...,"payload":{...},"deadline":...}
consume → serve : {"type":"answer","id":...,"content":"..."}   (≤1 accepted)
consume → serve : {"type":"giveup","id":...}   (request aged out client-side)
consume → serve : {"type":"heartbeat"}         (sent by `consume` automatically)
```

The `consume` process auto-heartbeats every 10s; the Muse agent only handles
`request` (produce an answer) and emits `answer`/`giveup`.

## Liveness & recovery (reaper, ~1s tick in `serve`)

| Condition | Action |
|---|---|
| No heartbeat > 30s | Drop consumer session; re-queue its leased rows (or expire if `attempts ≥ MAX_ATTEMPTS`) |
| Lease expired | Same re-queue path |
| `deadline` passed | `status='expired'`, waiter → HTTP 504 |
| Client disconnected (abort) | Delete row if `pending`, else mark `expired`; late answer discarded by the latch |
| `done`/`expired` older than 10 min | Purged |

Defaults: deadline 240s, lease 60s, heartbeat 10s/timeout 30s,
`MAX_ATTEMPTS` 3, `MAX_DEPTH` 64 — all env-overridable.

## OpenAI-compatible surface (`:8765`)

- `GET /health` → `{"ok":true, consumers, depth}`
- `GET /v1/models` → list containing `muse`
- `POST /v1/chat/completions`
  - malformed JSON → 400; dashboard probe (`stream:false`,
    `max_tokens:1024`, last user message `"hi"`) → instant canned answer;
  - no consumers → 503; depth ≥ `MAX_DEPTH` → 429;
  - `stream:false` → wait for answer → `chat.completion` object (echoes the
    requested `model`, defaults `muse`, zero `usage` — tokens are unknown to
    the bridge);
  - `stream:true` → SSE: headers + keepalive comments immediately (proxy-safe),
    then one `chat.completion.chunk` with full content, one with
    `finish_reason:"stop"`, then `data: [DONE]`;
  - deadline exceeded → 504 (non-stream) or SSE error event + `[DONE]`.

## Consumer side

`bun src/cli.ts consume [--id muse-N] [--hub ws://127.0.0.1:8767]` —
connects, sends `hello`, forwards hub→stdout and stdin→hub, heartbeats on its
own, exits when either side closes (SSH drop → Muse re-bootstrap via cron).

Muse-side instruction (replaces the old file-queue poller): hold
`ssh … "bun src/cli.ts consume --id muse-N"` open; for each `request` line
received, answer the last user message as the model and emit one `answer`
line on stdin.

## Configuration (env)

`HOST` (127.0.0.1), `PORT` (8765), `HUB_HOST` (127.0.0.1), `HUB_PORT` (8767),
`DB_PATH` (./data/bridge.db), `MAX_DEPTH`, `DEADLINE_MS`, `LEASE_MS`,
`HEARTBEAT_MS`, `HEARTBEAT_TIMEOUT_MS`, `MAX_ATTEMPTS`.

## Testing

1. **Exactly-once race** — two consumers answer the same leased request; one
   UPDATE wins, the other discarded; waiters see exactly one answer.
2. **Dispatch** — least-busy push, one in-flight per consumer, pull on
   hello/handoff.
3. **Fail-fast** — no consumer → 503; depth limit → 429.
4. **Recovery** — kill/heartbeat-loss mid-lease → row re-queued to another
   consumer; deadline → 504.
5. **E2E** — real HTTP client through `serve`, fake consumer over WS:
   non-stream 200 shape, SSE stream shape, probe shortcut, `/health`,
   `/v1/models`.
6. **Load** — burst N requests across M fake consumers: every request
   answered exactly once.

## Out of scope (v1)

Multi-process workers (single Bun event loop suffices — everything is I/O
wait), cron/file fallback (explicitly rejected: fail fast), token accounting
(`usage` always zeros), TLS (deploy behind 9Router / reverse proxy).
