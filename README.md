# muse-bridge

OpenAI-compatible bridge that answers `/v1/chat/completions` requests using
**Muse** (muse.ai agents) as the inference backend. Built for **Bun +
TypeScript + `bun:sqlite`**. No polling anywhere: Muse servers hold long-lived
SSH tunnels into the bridge and receive requests the moment they arrive.

```
Client / 9Router ──HTTP :8765──▶ bun serve ── bun:sqlite (WAL)
                                    ▲
                                    │ internal WebSocket hub :8767
                                    │
   Muse #1 ──ssh "bun src/cli.ts consume"──┤   (one request in flight
   Muse #2 ──ssh "bun src/cli.ts consume"──┤    per consumer, round-robin,
   Muse #N ──ssh "bun src/cli.ts consume"──┘    exactly-once answers)
```

**Guarantees**

| Guarantee | Mechanism |
|---|---|
| Exactly-once answers | Atomic SQLite latch: `UPDATE … WHERE status='leased' AND consumer_id=?` — losing racers hit rowcount 0 and are discarded |
| Sub-second handoff | Event push over the tunnel; the only real latency is Muse's generation time |
| Fail-fast | No consumer attached → `503` instantly (no cron/file fallback) |
| Backpressure | Active queue ≥ `MAX_DEPTH` → `429` |
| Consumer death recovery | Heartbeat timeout / lease expiry → row re-queued to another Muse server |

Full design: [`docs/superpowers/specs/2026-10-05-muse-bridge-design.md`](docs/superpowers/specs/2026-10-05-muse-bridge-design.md)

---

## Setup

Every step below is self-contained: placeholders are in `<ANGLE_BRACKETS>`,
each step ends with a verification command and its expected output.

### 0. Prerequisites

- **Bun ≥ 1.1** on the VPS and on any machine running the consumer
  (`curl -fsSL https://bun.sh/install | bash`, then verify: `bun --version`)
- A **VPS** with sudo, running **9Router** (any OpenAI-compatible proxy works)
- ≥ 1 **Muse account** (muse.ai) whose sandbox can make **outbound SSH** to
  the VPS (the sandbox does not accept inbound connections — that is why the
  tunnel is initiated from the Muse side)

### 1. Run the test suite (sanity check)

```bash
bun install
bun test
```

Expected: `30 pass, 0 fail`.

### 2. Local smoke test (optional, two terminals)

Terminal A:

```bash
bun src/cli.ts serve
# -> muse-bridge serving OpenAI API on 127.0.0.1:8765 (consumer hub on 127.0.0.1:8767)
```

Terminal B — without a consumer, fail-fast is proven:

```bash
curl -s http://127.0.0.1:8765/health
# -> {"ok":true,"consumers":0,"depth":0}

curl -s http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"muse","messages":[{"role":"user","content":"hi"}]}'
# -> 503 {"error":{"message":"no Muse consumer attached"}}
```

Terminal C — attach a fake consumer and watch the round trip:

```bash
bun src/cli.ts consume --id fake-1
# then type exactly:
{"type":"answer","id":"x","content":"ignored"}
```

Better: use the automated e2e in `test/consumer.test.ts`, or attach a real
consumer in step 5 and re-run the curl — it now returns
`{"choices":[{"message":{"role":"assistant","content": … }}]}`.

### 3. Deploy the bridge on the VPS

```bash
# copy this repo to the VPS, then:
git clone git@github.com:azizramdan/muse-bridge.git
cd muse-bridge && bun install

# generates the systemd unit for THIS machine (user, paths, bun path)
# and starts it — nothing is hardcoded
sudo ./scripts/install-service.sh
```

> Manual alternative: `sudo cp muse-bridge.service /etc/systemd/system/`,
> then edit `User=`, the `/home/ubuntu/muse-bridge` paths, and the bun path
> in `ExecStart` for your host (a wrong `User=` fails with systemd status
> `217/USER`), `daemon-reload`, `enable --now`. The installer does all of
> this for you.

Verify:

```bash
systemctl status muse-bridge        # active (running)
curl -s http://127.0.0.1:8765/health
# -> {"ok":true,"consumers":0,"depth":0}
curl -s http://127.0.0.1:8765/v1/models
# -> {"object":"list","data":[{"id":"muse", ...}]}
```

### 4. Register the provider in 9Router

Preflight on the VPS (all must succeed):

```bash
systemctl status muse-bridge             # active (running)
curl -s http://127.0.0.1:8765/health      # {"ok":true,"consumers":0,"depth":0}
curl -s http://127.0.0.1:8765/v1/models   # list contains {"id":"muse",...}
```

Then, in the 9Router dashboard:

1. **Add provider** → type **OpenAI-compatible chat**.
   - Name `Muse`, Base URL `http://127.0.0.1:8765/v1` (same VPS → loopback,
     include `/v1`), API key left empty (the bridge never checks auth),
     prefix `muse` (exposes the bridge's `muse` model as `muse/muse`).
2. **Test Connection** — must go green **instantly**: the bridge answers
   dashboard probes before any queueing, even with zero workers attached.
   Green here does *not* prove a worker is attached.
3. Create a **combo** named `muse` containing model `muse/muse`.
4. Create an **API key** for your own use.
5. Set 9Router's upstream/request timeout to **≥ 250 s** — the bridge's own
   deadline is 240 s (`DEADLINE_MS`), so a shorter proxy timeout would cut
   clients off before the bridge can return `504`. SSE keepalives (15 s)
   already cover idle-read timeouts.

> If 9Router runs on a *different* host, the bridge's default
> `HOST=127.0.0.1` is unreachable — set `HOST` to the Tailscale IP (or
> `0.0.0.0`) and restart before registering.

### 5. Connect the Muse side (the tunnel)

**5a. Verify outbound SSH from the Muse sandbox to the VPS** (once):

```bash
ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=no \
  -o "ProxyCommand=<PROXY_CMD> %h %p" -i <PRIVATE_KEY> <USER>@<VPS_IP> "echo ok"
# -> ok
```

Drop the `ProxyCommand` option if you don't use an egress proxy. The public
key must be in `<USER>`'s `authorized_keys` on the VPS.

**5b. Give each Muse server this instruction** (a Muse cron run or a manual
prompt — it is written to be pasted verbatim):

> **Muse bridge consumer — instruction**
>
> You are the answer engine behind an OpenAI-compatible bridge. Your job is
> to hold one long-lived session and answer every request that arrives on it.
>
> 1. Open the session and keep it open:
>    `ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=no [-o "ProxyCommand=<PROXY_CMD> %h %p"] -i <PRIVATE_KEY> <USER>@<VPS_IP> "bun /home/ubuntu/muse-bridge/src/cli.ts consume --id muse-<N>"`
>    (replace `<N>` with this server's unique number: muse-1, muse-2, …)
>
> 2. The session speaks line-delimited JSON on stdin/stdout. Your stdout
>    receives messages like:
>    `{"type":"request","id":"<id>","payload":{…OpenAI request…},"deadline":<ms>}`
>
> 3. For **each** `request` line, in order:
>    a. Read `payload.messages` for context and answer the **last user
>       message** naturally, in the user's language. Respect `max_tokens` if
>       present. This is a normal assistant reply to an API client — do not
>       mention bridges, queues, or that you are a poller, and do not call
>       yourself "Muse" unless asked.
>    b. If the request's `deadline` has already passed, do not answer it —
>       just move on.
>    c. Write exactly one line to stdin:
>       `{"type":"answer","id":"<id>","content":"<your answer>"}`
>
> 4. Heartbeats are sent by the session automatically — never send them
>    yourself.
>
> 5. If the session ends (SSH drop, VPS restart), **reconnect immediately**
>    (step 1) and continue. Reconnect loops are expected and harmless.
>
> 6. Work silently: no status messages to the user between requests. Message
>    the user only if SSH fails 3 times in a row.

**5c. Verify a consumer attached:**

```bash
curl -s http://127.0.0.1:8765/health
# -> {"ok":true,"consumers":1,"depth":0}
```

### 6. End-to-end check

```bash
curl -s https://<HOST_9ROUTER>/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY_9ROUTER>" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse","messages":[{"role":"user","content":"Halo, siapa kamu?"}]}'
```

Expected: a valid `chat.completion` JSON answered by Muse. With the tunnel
live, latency ≈ Muse's generation time (no 10s poll cycle).

### 7. Adding another Muse worker (scale-out)

Nothing changes on the VPS — no restart, no config, no 9Router edit. To add
a worker:

1. Take the paste-ready prompt in
   [`docs/muse-bootstrap-prompt.md`](docs/muse-bootstrap-prompt.md),
   fill in `<WORKER_ID>` (e.g. `muse-2`), `<PRIVATE_KEY>`, `<USER>`,
   `<VPS_IP>` (+ `<PROXY_CMD>` if used).
2. Paste it into the new Muse run. It verifies SSH itself, attaches the
   tunnel, answers per the protocol, and self-checks `/health`.
3. Confirm:

   ```bash
   curl -s http://127.0.0.1:8765/health
   # -> {"ok":true,"consumers":2,"depth":0}
   ```

Requests are then dispatched round-robin across all attached workers.

> ⚠️ **Each worker needs a unique `--id`.** Reusing an id makes the bridge
> treat the new session as a reconnect and detach the old one — two workers
> on the same id will kick each other off in a loop.

Removing a worker = end its session; its in-flight request re-queues to
another worker automatically.

### 8. One SSH user per Muse worker (isolated layout)

Run each worker as its **own local account** with a **forced command**, so
each Muse key can only ever be this one consumer with this one id:

```bash
# 1. one shared bun for all worker users (they only RUN consume)
sudo install -m 755 "$(which bun)" /usr/local/bin/bun

# 2. code world-READABLE, data never (worker users never touch the DB)
chmod 700 ~/muse-bridge-data 2>/dev/null || chmod 700 data   # DB dir: owner-only
sudo chmod -R a+rX src scripts package.json
chmod o+x ~                     # only if `namei -l src/cli.ts` shows your home lacks o+x

# 3. per worker: account + its Muse public key with a pinned consume command
sudo useradd -m -s /bin/bash muse1
sudo -u muse1 mkdir -p ~/.ssh && sudo -u muse1 chmod 700 ~/.ssh
sudo -u muse1 tee -a ~/.ssh/authorized_keys <<'EOF'
command="/usr/local/bin/bun /ABSOLUTE/PATH/TO/muse-bridge/src/cli.ts consume --id muse-1",restrict ssh-ed25519 AAAA... <Muse worker 1 pubkey>
EOF
sudo -u muse1 chmod 600 ~/.ssh/authorized_keys
```

- One account = one id (`muse1` → `muse-1`), so duplicate-id ping-ponging
  is structurally impossible.
- With `command=`, the remote command is ignored: the Muse instruction
  simplifies to plain `ssh -i <KEY> muse1@<VPS_IP>` (see the hardened
  variant in [`docs/muse-bootstrap-prompt.md`](docs/muse-bootstrap-prompt.md)).
- `serve` still runs once as your own user via systemd — nothing else needs
  sudo, and worker users never need sudo.
- ⚠️ The hub (`127.0.0.1:8767`) is unauthenticated: any **local** user could
  attach as a consumer. Only create accounts you trust.

---

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Public API bind address (set to Tailscale IP for tailnet access) |
| `PORT` | `8765` | Public OpenAI API port |
| `HUB_HOST` | `127.0.0.1` | Internal consumer-hub bind (keep local) |
| `HUB_PORT` | `8767` | Internal consumer-hub port |
| `DB_PATH` | `./data/bridge.db` | SQLite file (WAL mode) |
| `MAX_DEPTH` | `64` | Active (`pending`+`leased`) rows before `429` |
| `DEADLINE_MS` | `240000` | Max total wait before `504` |
| `LEASE_MS` | `60000` | How long one consumer may hold a request |
| `HEARTBEAT_MS` | `10000` | Heartbeat interval (consumed by `consume`) |
| `HEARTBEAT_TIMEOUT_MS` | `30000` | Silence before a consumer is dropped |
| `MAX_ATTEMPTS` | `3` | Delivery attempts before a request expires |

## HTTP API

| Endpoint | Behavior |
|---|---|
| `GET /health` | `{ok, consumers, depth}` |
| `GET /v1/models` | list containing `muse` |
| `POST /v1/chat/completions` | OpenAI-compatible; `stream:true` supported (SSE with immediate headers + keepalives) |

Error codes: `400` bad JSON · `503` no consumer (fail-fast) · `429` queue
full · `504` deadline exceeded · dashboard probe (`stream:false`,
`max_tokens:1024`, last message `"hi"`) answered instantly by design.

## Wire protocol (hub ⇄ consumer)

```
consume → serve : {"type":"hello","consumer":"muse-1"}
serve  → consume: {"type":"request","id","payload","deadline"}
consume → serve : {"type":"answer","id","content"}   (≤1 accepted)
consume → serve : {"type":"giveup","id"}             (request aged out)
consume → serve : {"type":"heartbeat"}               (automatic)
```

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `503 no Muse consumer` | Tunnel not connected | `curl :8765/health`; Muse session logs |
| `504 Muse did not answer in time` | Muse run died / deadline hit | Reconnect instruction (5b.5); `DEADLINE_MS` |
| `429 bridge busy` | Consumers slower than arrival rate | Add Muse servers; raise `MAX_DEPTH` |
| `Test Connection` green but real calls 503 | Probe shortcut hides a dead tunnel | `/health` `consumers` field |
| Duplicate-looking answers | Should be impossible — latch discards losers | Inspect `SELECT id,status,answer FROM requests` |
| Consumer flaps every 30s | Heartbeats not arriving (old binary?) | `HEARTBEAT_MS` < `HEARTBEAT_TIMEOUT_MS` |

## Development

```bash
bun test              # 30 tests: hub, HTTP surface, consume process, load/exactly-once
bun src/cli.ts serve  # run the bridge locally
```

Layout: `src/hub.ts` (queue + exactly-once latch), `src/server.ts` (HTTP +
hub sockets), `src/consumer.ts` (stdio ⇄ hub bridge), `src/openai.ts`
(response shapes), `src/db.ts` (schema), `src/cli.ts` (entry).
