import { z } from "zod";

import { LOCAL_USER_ID } from "../http/auth.js";
import { db } from "./db.js";

const OutlookModeSchema = z.enum(["oauth", "imap"]);

const AccountSchema = z.object({
  email: z.string().email(),
});

const ConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  qq: z
    .object({
      // Multi-account: each QQ mailbox is one entry. The auth code lives in the
      // secret store under `qq:${email}` (see ProviderManager).
      // Reason: factory defaults — a literal default object is shared across all
      // zod parses, so two users' configs would alias the same array.
      accounts: z.array(AccountSchema).default(() => []),
    })
    .default(() => ({ accounts: [] })),
  outlook: z
    .object({
      mode: OutlookModeSchema.default("oauth"),
      clientId: z.string().min(8).optional(), // OAuth mode (single account)
      // Multi-account IMAP: app password lives under `outlook_imap:${email}`.
      imapAccounts: z.array(AccountSchema).default(() => []),
    })
    .default(() => ({ mode: "oauth" as const, imapAccounts: [] })),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type Account = z.infer<typeof AccountSchema>;

// Legacy single-account shape (pre multi-account). Used only for migration.
type LegacyShape = {
  qq?: { email?: string; accounts?: unknown };
  outlook?: { imapEmail?: string; imapAccounts?: unknown };
};

// Migrate the old single-value fields (qq.email / outlook.imapEmail) into the
// new account arrays. Returns true if anything changed, so the caller can
// persist the upgraded config back to disk.
function migrateLegacy(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  let changed = false;
  const legacy = raw as LegacyShape;

  if (legacy.qq && typeof legacy.qq.email === "string" && !Array.isArray(legacy.qq.accounts)) {
    raw.qq.accounts = [{ email: legacy.qq.email }];
    delete raw.qq.email;
    changed = true;
  }
  if (
    legacy.outlook &&
    typeof legacy.outlook.imapEmail === "string" &&
    !Array.isArray(legacy.outlook.imapAccounts)
  ) {
    raw.outlook.imapAccounts = [{ email: legacy.outlook.imapEmail }];
    delete raw.outlook.imapEmail;
    changed = true;
  }
  return changed;
}

// Per-user config is stored as a JSON document in the `configs` table, keyed by
// userId ("local" for the single-tenant instance).
export async function loadConfig(userId: string = LOCAL_USER_ID): Promise<AppConfig> {
  const row = db.prepare("SELECT json FROM configs WHERE user_id = ?").get(userId) as
    | { json: string }
    | undefined;
  if (!row) return ConfigSchema.parse({});
  try {
    const raw = JSON.parse(row.json);
    const migrated = migrateLegacy(raw);
    const cfg = ConfigSchema.parse(raw);
    // Persist the upgraded shape once so legacy fields don't linger.
    if (migrated) await saveConfig(cfg, userId);
    return cfg;
  } catch {
    return ConfigSchema.parse({});
  }
}

export async function saveConfig(cfg: AppConfig, userId: string = LOCAL_USER_ID): Promise<void> {
  const json = JSON.stringify(cfg);
  db.prepare(
    "INSERT INTO configs (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json"
  ).run(userId, json);
}
