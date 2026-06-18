import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../constants.js";

/*
 * SQLite-backed persistence for the agent (users, secrets, per-user config).
 * Uses Node's built-in node:sqlite (no native build step), so it works in a
 * plain node:24-alpine container. The OTP store stays in-memory by design —
 * codes are transient and expire within minutes.
 *
 * One database file lives in the data volume: ${DATA_DIR}/agent.db
 */

const DB_PATH = path.join(DATA_DIR, "agent.db");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS secrets (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS configs (
    user_id TEXT PRIMARY KEY,
    json    TEXT NOT NULL
  );
`);

// One-time import of legacy JSON files into the DB. Runs only when the relevant
// table is still empty, so it's safe to call on every startup. Preserves the
// existing self-hosted deployment's data when upgrading to the DB backend.
export function migrateJsonToDb(): void {
  try {
    importUsers();
    importSecrets();
    importConfigs();
  } catch (e) {
    console.error("[otp-agent] JSON→DB migration error:", String((e as any)?.message || e));
  }
}

function tableEmpty(table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n === 0;
}

function importUsers(): void {
  const file = path.join(DATA_DIR, "users.json");
  if (!existsSync(file) || !tableEmpty("users")) return;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const users = Array.isArray(parsed?.users) ? parsed.users : [];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  );
  for (const u of users) {
    if (u?.id && u?.username) ins.run(u.id, u.username, u.passwordHash ?? "", Number(u.createdAt) || 0);
  }
  if (users.length) console.log(`[otp-agent] migrated ${users.length} user(s) from users.json → DB`);
}

function importSecrets(): void {
  const file = path.join(DATA_DIR, "secrets.json");
  if (!existsSync(file) || !tableEmpty("secrets")) return;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const secrets = parsed?.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {};
  const ins = db.prepare("INSERT OR IGNORE INTO secrets (key, value) VALUES (?, ?)");
  let n = 0;
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string") {
      ins.run(k, v);
      n++;
    }
  }
  if (n) console.log(`[otp-agent] migrated ${n} secret(s) from secrets.json → DB`);
}

function importConfigs(): void {
  if (!tableEmpty("configs")) return;
  const ins = db.prepare("INSERT OR IGNORE INTO configs (user_id, json) VALUES (?, ?)");
  let n = 0;
  // Legacy single-tenant file → "local" user.
  const localFile = path.join(DATA_DIR, "config.json");
  if (existsSync(localFile)) {
    ins.run("local", readFileSync(localFile, "utf8"));
    n++;
  }
  // Per-user files config-<userId>.json
  for (const name of safeReaddir(DATA_DIR)) {
    const m = /^config-(.+)\.json$/.exec(name);
    if (m) {
      ins.run(m[1]!, readFileSync(path.join(DATA_DIR, name), "utf8"));
      n++;
    }
  }
  if (n) console.log(`[otp-agent] migrated ${n} config file(s) → DB`);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
