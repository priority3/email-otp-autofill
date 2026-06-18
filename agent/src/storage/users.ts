import crypto from "node:crypto";

import { db } from "./db.js";

export type User = {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
};

// --- password hashing (scrypt, constant-time verify) ----------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- user store (SQLite) --------------------------------------------------

function normUsername(username: string): string {
  return username.trim().toLowerCase();
}

function rowToUser(r: UserRow): User {
  return { id: r.id, username: r.username, passwordHash: r.password_hash, createdAt: r.created_at };
}

export async function findByUsername(username: string): Promise<User | null> {
  const r = db.prepare("SELECT * FROM users WHERE username = ?").get(normUsername(username)) as
    | UserRow
    | undefined;
  return r ? rowToUser(r) : null;
}

export async function getUser(userId: string): Promise<User | null> {
  const r = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  return r ? rowToUser(r) : null;
}

export async function listUserIds(): Promise<string[]> {
  const rows = db.prepare("SELECT id FROM users").all() as { id: string }[];
  return rows.map((r) => r.id);
}

// Create a user. Throws "username_taken" if the (normalized) name exists.
// `inviteCode` is recorded for traceability (already validated/consumed by the
// caller when invites are required).
export async function createUser(username: string, password: string, inviteCode?: string): Promise<User> {
  const user: User = {
    id: crypto.randomUUID(),
    username: normUsername(username),
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };
  try {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, created_at, invite_code) VALUES (?, ?, ?, ?, ?)"
    ).run(user.id, user.username, user.passwordHash, user.createdAt, inviteCode ?? null);
  } catch (e) {
    // UNIQUE constraint on username.
    if (String((e as any)?.message || e).includes("UNIQUE")) throw new Error("username_taken");
    throw e;
  }
  return user;
}
