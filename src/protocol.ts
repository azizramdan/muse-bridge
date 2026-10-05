/** Messages exchanged between `serve` and `consume` over the internal hub. */

/** consume → serve, first message on connect. */
export interface HelloMsg {
  type: "hello";
  consumer: string;
}

/** serve → consume: a request awaiting an answer. */
export interface RequestMsg {
  type: "request";
  id: string;
  payload: unknown;
  deadline: number;
}

/** consume → serve: the answer text for a leased request (accepted at most once). */
export interface AnswerMsg {
  type: "answer";
  id: string;
  content: string;
}

/** consume → serve: the consumer cannot answer this request (e.g. it aged out). */
export interface GiveupMsg {
  type: "giveup";
  id: string;
}

/** consume → serve: liveness signal (sent automatically by the consume process). */
export interface HeartbeatMsg {
  type: "heartbeat";
}

export type ClientMsg = HelloMsg | AnswerMsg | GiveupMsg | HeartbeatMsg;
export type ServerMsg = RequestMsg;
