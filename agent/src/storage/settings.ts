import { db } from "./db.js";

/*
 * Key/value app settings stored in the `settings` table. Currently holds the
 * "require invite code to register" toggle, switchable live from the admin page.
 */

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

const REQUIRE_INVITE_KEY = "require_invite";

// Default false: a fresh instance must allow registration so the first user
// (and the admin) can get in before any invite codes exist.
export function isInviteRequired(): boolean {
  return getSetting(REQUIRE_INVITE_KEY, "0") === "1";
}

export function setInviteRequired(on: boolean): void {
  setSetting(REQUIRE_INVITE_KEY, on ? "1" : "0");
}

const OUTLOOK_CLIENT_ID_KEY = "outlook_client_id";

// Instance-wide Microsoft App (client) ID for Outlook OAuth. The admin registers
// one app and sets it here; every user's OAuth sign-in shares it. Empty = unset.
export function getOutlookClientId(): string {
  return getSetting(OUTLOOK_CLIENT_ID_KEY, "").trim();
}

export function setOutlookClientId(clientId: string): void {
  setSetting(OUTLOOK_CLIENT_ID_KEY, clientId.trim());
}

const GOOGLE_CLIENT_ID_KEY = "google_client_id";
const GOOGLE_CLIENT_SECRET_KEY = "google_client_secret";

// Instance-wide Google OAuth client ID and secret. Unlike Microsoft's public
// client flow, Google's device code flow requires both a client ID and secret.
export function getGoogleClientId(): string {
  return getSetting(GOOGLE_CLIENT_ID_KEY, "").trim();
}

export function setGoogleClientId(clientId: string): void {
  setSetting(GOOGLE_CLIENT_ID_KEY, clientId.trim());
}

export function getGoogleClientSecret(): string {
  return getSetting(GOOGLE_CLIENT_SECRET_KEY, "").trim();
}

export function setGoogleClientSecret(clientSecret: string): void {
  setSetting(GOOGLE_CLIENT_SECRET_KEY, clientSecret.trim());
}

const PUBSUB_AUDIENCE_KEY = "pubsub_audience";

// Expected audience claim for Google Pub/Sub Push OIDC tokens.
// Typically your agent's public URL, e.g. "https://your-agent.example.com/v1/gmail/pubsub"
export function getPubSubAudience(): string {
  return getSetting(PUBSUB_AUDIENCE_KEY, "").trim();
}

export function setPubSubAudience(audience: string): void {
  setSetting(PUBSUB_AUDIENCE_KEY, audience.trim());
}
