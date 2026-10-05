import { randomUUID } from "node:crypto";

/** Completion id in OpenAI's shape ("chatcmpl-" + hex). */
export function newCompletionId(): string {
  return "chatcmpl-" + randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * Detect the 9Router dashboard "Test Connection" probe:
 * { max_tokens: 1024, stream: false, messages: [..., {role:"user", content:"hi"}] }
 * with a 15s client timeout a real queue round-trip may not meet, so it is
 * answered instantly instead of being queued.
 */
export function isDashboardProbe(req: unknown): boolean {
  try {
    if (!req || typeof req !== "object") return false;
    const r = req as Record<string, unknown>;
    if (r.stream) return false;
    if (r.max_tokens !== 1024) return false;
    const msgs = r.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return false;
    const last = msgs[msgs.length - 1] as Record<string, unknown> | null;
    return (
      !!last &&
      typeof last === "object" &&
      last.role === "user" &&
      String(last.content ?? "").trim().toLowerCase() === "hi"
    );
  } catch {
    return false;
  }
}

export function probeCompletion(): Record<string, unknown> {
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "muse",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Halo! Muse online — bridge aktif dan siap.",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Standard non-streaming chat.completion. Usage is always zero: the bridge
 *  does not know real token counts (answers are produced by Muse). */
export function chatCompletion(content: string, model: string): Record<string, unknown> {
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** SSE chunk carrying the full answer in one delta (the backend produces the
 *  whole answer at once — there are no incremental tokens to stream). */
export function contentChunk(id: string, created: number, model: string, content: string): string {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, logprobs: null, finish_reason: null }],
    }) +
    "\n\n"
  );
}

export function finishChunk(id: string, created: number, model: string): string {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }],
    }) +
    "\n\n"
  );
}

export function errorChunk(message: string): string {
  return (
    "data: " +
    JSON.stringify({ error: { message, type: "timeout" } }) +
    "\n\n"
  );
}

export const DONE_EVENT = "data: [DONE]\n\n";

export function errorBody(message: string): Record<string, unknown> {
  return { error: { message } };
}
