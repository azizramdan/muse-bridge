import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consumer_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  answer TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status, received_at);
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function createSchema(db: Database): void {
  db.exec(SCHEMA);
}
