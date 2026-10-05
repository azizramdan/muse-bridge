import type { BridgeConfig } from "./config";

/** Read line-delimited JSON from a stream (stdin by default). */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

/**
 * The consumer side of the bridge: connects to the internal hub and bridges
 * it to stdin/stdout so it can live inside an SSH session.
 *
 *   ssh vps "bun src/cli.ts consume --id muse-1"
 *
 * stdout carries hub → Muse messages (request lines); stdin carries
 * Muse → hub messages (answer / giveup). Heartbeats are sent by this
 * process automatically — the Muse agent only ever handles `request` lines.
 *
 * Resolves when either side closes (SSH dropped, hub restarted, stdin ended).
 * Exit code: 0 on clean end, 1 on connection failure.
 */
export async function runConsumer(
  cfg: BridgeConfig,
  hubUrl: string,
  id: string,
): Promise<number> {
  const ws = new WebSocket(hubUrl);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot connect to consumer hub at ${hubUrl}`));
  });

  ws.send(JSON.stringify({ type: "hello", consumer: id }));

  const ended = new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, cfg.heartbeatMs);

  ws.onmessage = (ev) => {
    process.stdout.write(String(ev.data) + "\n");
  };

  const stdinStream = Bun.stdin.stream();
  const pumpStdin = (async () => {
    try {
      for await (const line of lines(stdinStream)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(line);
      }
    } finally {
      // the peer closed our stdin (e.g. SSH channel ended) -> end the session
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  })();

  await Promise.race([ended, pumpStdin]);
  clearInterval(heartbeat);

  // release the stdin reader so the process can actually exit
  await stdinStream.cancel().catch(() => {});

  try {
    ws.close();
  } catch {
    // already closed
  }
  return 0;
}
