import { createSchema, openDb } from "./db";
import type { BridgeConfig } from "./config";
import {
  ClientDisconnectedError,
  DeadlineExceededError,
  Hub,
  NoConsumersError,
  QueueFullError,
} from "./hub";
import {
  DONE_EVENT,
  chatCompletion,
  contentChunk,
  errorBody,
  errorChunk,
  finishChunk,
  isDashboardProbe,
  newCompletionId,
  probeCompletion,
} from "./openai";

export interface RunningBridge {
  hub: Hub;
  publicPort: number;
  hubPort: number;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Reaper tick interval; tests lower it to exercise deadlines quickly. */
  reaperMs?: number;
}

interface HubData {
  cid?: string;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof NoConsumersError) return json(503, errorBody(err.message));
  if (err instanceof QueueFullError) return json(429, errorBody(err.message));
  if (err instanceof DeadlineExceededError) return json(504, errorBody(err.message));
  if (err instanceof ClientDisconnectedError) return json(499, errorBody(err.message));
  const message = err instanceof Error ? err.message.slice(0, 200) : "internal error";
  return json(500, errorBody(message));
}

function bodyModel(payload: Record<string, unknown>): string {
  return typeof payload.model === "string" && payload.model ? payload.model : "muse";
}

async function handleChat(
  hub: Hub,
  cfg: BridgeConfig,
  req: Request,
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse((await req.text()) || "{}");
  } catch {
    return json(400, errorBody("bad json"));
  }
  if (typeof payload !== "object" || payload === null) {
    return json(400, errorBody("bad json"));
  }

  if (isDashboardProbe(payload)) return json(200, probeCompletion());

  // Fail-fast BEFORE committing to a response shape.
  if (hub.consumerCount === 0) {
    return json(503, errorBody("no Muse consumer attached"));
  }
  if (hub.depth >= cfg.maxDepth) {
    return json(429, errorBody("Muse bridge busy, try again in a bit"));
  }

  const model = bodyModel(payload);

  if (!payload.stream) {
    try {
      const content = await hub.submit(payload, { signal: req.signal });
      return json(200, chatCompletion(content, model));
    } catch (err) {
      return errorResponse(err);
    }
  }

  // Streaming: SSE headers go out immediately (proxy-safe), the answer
  // follows when a consumer produces it; keepalives hold the connection.
  let requestId: string | undefined;
  const answer = hub.submit(payload, { onId: (id) => (requestId = id) });
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // client went away; the settle paths below swallow the rest
        }
      };
      enqueue(": connected\n\n");
      const ping = setInterval(() => enqueue(": ping\n\n"), 15_000);
      answer.then(
        (content) => {
          clearInterval(ping);
          const id = newCompletionId();
          const created = Math.floor(Date.now() / 1000);
          enqueue(contentChunk(id, created, model, content));
          enqueue(finishChunk(id, created, model));
          enqueue(DONE_EVENT);
          try {
            controller.close();
          } catch {
            // already gone
          }
        },
        (err) => {
          clearInterval(ping);
          if (err instanceof ClientDisconnectedError) return;
          enqueue(errorChunk(err instanceof Error ? err.message : "unknown error"));
          enqueue(DONE_EVENT);
          try {
            controller.close();
          } catch {
            // already gone
          }
        },
      );
    },
    cancel() {
      if (requestId) hub.abort(requestId);
    },
  });
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "Connection": "keep-alive",
    },
  });
}

async function handlePublic(hub: Hub, cfg: BridgeConfig, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (req.method === "GET" && path === "/health") {
    return json(200, { ok: true, consumers: hub.consumerCount, depth: hub.depth });
  }
  if (req.method === "GET" && path === "/v1/models") {
    return json(200, {
      object: "list",
      data: [{ id: "muse", object: "model", created: 0, owned_by: "muse" }],
    });
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return handleChat(hub, cfg, req);
  }
  return json(404, errorBody("not found"));
}

/** Start the public OpenAI API and the internal consumer hub. */
export function startBridge(cfg: BridgeConfig, opts: StartOptions = {}): RunningBridge {
  const db = openDb(cfg.dbPath);
  createSchema(db);
  const hub = new Hub(db, cfg);
  hub.startReaper(opts.reaperMs ?? 1_000);

  const publicSrv = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    fetch: (req) => handlePublic(hub, cfg, req),
  });

  const hubSrv = Bun.serve({
    hostname: cfg.hubHost,
    port: cfg.hubPort,
    fetch: (req, srv) =>
      srv.upgrade(req, { data: {} as HubData })
        ? undefined
        : new Response("hub only", { status: 426 }),
    websocket: {
      open(ws: { data: HubData }) {
        ws.data = ws.data ?? {};
      },
      message(ws: { data: HubData; send(data: string): number }, raw: string | Uint8Array) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
          return;
        }
        if (msg.type === "hello" && typeof msg.consumer === "string") {
          ws.data.cid = msg.consumer;
          hub.attach(msg.consumer, {
            send: (out) => {
              try {
                ws.send(JSON.stringify(out));
              } catch {
                // socket dying; the close handler will detach
              }
            },
          });
          return;
        }
        if (ws.data.cid) hub.handleMessage(ws.data.cid, msg);
      },
      close(ws: { data: HubData }) {
        if (ws.data.cid) hub.detach(ws.data.cid);
      },
    },
  });

  return {
    hub,
    publicPort: publicSrv.port,
    hubPort: hubSrv.port,
    async close() {
      hub.close();
      publicSrv.stop(true);
      hubSrv.stop(true);
      db.close();
    },
  };
}
