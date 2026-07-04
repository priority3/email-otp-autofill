import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { z } from "zod";

import { AGENT_HOST, AGENT_PORT, MASTER_KEY } from "./constants.js";
import { cors, noStore, requireClientHeader } from "./http/middleware.js";
import { extractBearerToken, verifyGoogleOidcToken } from "./http/verify-oidc.js";
import {
  createSession,
  destroySession,
  destroyUserSessions,
  requireAdmin,
  requireAuth,
  resolveSession,
} from "./http/auth.js";
import { OtpStore } from "./otp/store.js";
import { ProviderManager, ProviderRegistry } from "./providers/manager.js";
import { verifyImap } from "./providers/imap.js";
import { db, migrateJsonToDb } from "./storage/db.js";
import { migratePlaintextSecrets, secretGet, secretSet } from "./storage/secrets.js";
import {
  createUser,
  findByUsername,
  getUser,
  listUserIds,
  listUsers,
  setUserDisabled,
  verifyPassword,
} from "./storage/users.js";
import { loadConfig } from "./storage/config.js";
import {
  createInvites,
  consumeInvite,
  inviteStats,
  isInviteUsable,
  listInvites,
  revokeInvite,
} from "./storage/invites.js";
import {
  isInviteRequired,
  setInviteRequired,
  getOutlookClientId,
  setOutlookClientId,
  getGoogleClientId,
  setGoogleClientId,
  getGoogleClientSecret,
  setGoogleClientSecret,
  getPubSubAudience,
  setPubSubAudience,
} from "./storage/settings.js";

function parseProviders(raw: string | undefined): ("qq" | "outlook" | "gmail")[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<"qq" | "outlook" | "gmail">();
  for (const p of parts) {
    if (p === "qq" || p === "outlook" || p === "gmail") set.add(p);
  }
  return set.size ? [...set] : undefined;
}

export async function startServer() {
  // Every user's email credentials are encrypted at rest with the master key;
  // without it they would be stored in plaintext.
  if (!MASTER_KEY) {
    console.warn(
      "[otp-agent] WARNING: OTP_AGENT_MASTER_KEY is not set — email credentials would be stored " +
        "in PLAINTEXT. Set OTP_AGENT_MASTER_KEY."
    );
  }
  // Import any legacy JSON files into SQLite (one-time, before reading the DB).
  migrateJsonToDb();
  await migratePlaintextSecrets();

  const app = express();
  app.disable("x-powered-by");
  app.use(cors);
  app.use(noStore);
  // Skip JSON parsing for the Pub/Sub webhook — it receives raw push bodies.
  app.use((req, res, next) => {
    if (req.path === "/v1/gmail/pubsub" && req.method === "POST") return next();
    return express.json({ limit: "256kb" })(req, res, next);
  });
  app.use(requireClientHeader);

  const store = new OtpStore();
  const registry = new ProviderRegistry(store);

  // Boot watchers for every registered user.
  await registry.bootstrap(await listUserIds());

  // Resolve the ProviderManager for the current request's authenticated user.
  async function mgrFor(req: express.Request): Promise<ProviderManager> {
    return registry.getOrCreate(String(req.userId));
  }

  // ---- auth endpoints ----------------------------------------------------
  const Creds = z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(8).max(200),
  });

  const RegBody = Creds.extend({ inviteCode: z.string().trim().optional() });

  app.post("/v1/auth/register", async (req, res) => {
    const body = RegBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });

    const code = (body.data.inviteCode || "").toUpperCase();
    // Pre-check the invite when required; the actual claim happens after the
    // user row is created (atomic consumeInvite guards against double-use).
    if (isInviteRequired()) {
      if (!code || !isInviteUsable(code)) {
        return res.status(400).json({ ok: false, error: "invalid_invite" });
      }
    }

    try {
      const user = await createUser(body.data.username, body.data.password, code || undefined);
      if (isInviteRequired()) {
        // Claim atomically; if someone raced us to the code, roll back.
        if (!consumeInvite(code, user.id)) {
          db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
          return res.status(400).json({ ok: false, error: "invalid_invite" });
        }
      }
      await registry.getOrCreate(user.id); // empty config, ready for accounts
      const token = createSession(user.id);
      res.json({ ok: true, token, user: { id: user.id, username: user.username } });
    } catch (e) {
      const msg = String((e as any)?.message || e);
      res.status(msg === "username_taken" ? 409 : 400).json({ ok: false, error: msg });
    }
  });

  app.post("/v1/auth/login", async (req, res) => {
    const body = Creds.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const user = await findByUsername(body.data.username);
    if (!user || !verifyPassword(body.data.password, user.passwordHash)) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }
    if (user.disabled) {
      return res.status(401).json({ ok: false, error: "account_disabled" });
    }
    const token = createSession(user.id);
    res.json({ ok: true, token, user: { id: user.id, username: user.username } });
  });

  app.post("/v1/auth/logout", requireAuth, (req, res) => {
    const h = String(req.headers.authorization || "");
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) destroySession(m[1]!.trim());
    res.json({ ok: true });
  });

  app.get("/v1/auth/me", requireAuth, async (req, res) => {
    const user = await getUser(String(req.userId));
    if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  });

  // Gate: every /v1 route except status, auth, admin, and the pubsub webhook
  // requires a valid user session. The pubsub webhook uses OIDC token auth instead.
  // Admin routes have their own requireAdmin guard.
  app.use((req, res, next) => {
    const p = req.path;
    if (!p.startsWith("/v1/")) return next();
    if (p === "/v1/status" || p.startsWith("/v1/auth/") || p.startsWith("/v1/admin/")) return next();
    if (p === "/v1/gmail/pubsub" && req.method === "POST") return next();
    if (p === "/v1/gmail/auth/callback") return next(); // OAuth redirect from Google
    return requireAuth(req, res, next);
  });

  // ---- status ------------------------------------------------------------
  app.get("/v1/status", async (req, res) => {
    // Reachable without auth; reports per-user data only with a valid session.
    const h = String(req.headers.authorization || "");
    const m = /^Bearer\s+(.+)$/i.exec(h);
    const userId = m ? resolveSession(m[1]!.trim()) : null;
    if (!userId) {
      return res.json({
        ok: true,
        agent: { host: AGENT_HOST, port: AGENT_PORT },
        multiTenant: true,
        authenticated: false,
        requireInvite: isInviteRequired(),
      });
    }
    const mgr = await registry.getOrCreate(userId);
    const cfg = mgr.config;
    const qqAccounts = await Promise.all(
      cfg.qq.accounts.map(async (a) => ({
        email: a.email,
        configured: Boolean(await secretGet(mgr.secretKeyFor("qq", a.email))),
      }))
    );
    const outlookOauthConnected = await mgr.getOutlookOAuth().hasRefreshToken();
    const outlookOauthEmail = outlookOauthConnected ? await mgr.getOutlookOAuth().getAccountEmail() : null;
    const outlookClientId = getOutlookClientId();
    const gmailOauthConnected = await mgr.getGmailOAuth().hasRefreshToken();
    const gmailOauthEmail = gmailOauthConnected ? await mgr.getGmailOAuth().getAccountEmail() : null;
    const googleClientId = getGoogleClientId();
    res.json({
      ok: true,
      agent: { host: AGENT_HOST, port: AGENT_PORT },
      multiTenant: true,
      authenticated: true,
      config: {
        pollIntervalMs: cfg.pollIntervalMs,
        qq: { accounts: qqAccounts },
        outlook: {
          mode: cfg.outlook.mode,
          // Client ID is now an instance-wide admin setting (not per-user).
          clientId: outlookClientId || null,
          clientIdSet: Boolean(outlookClientId),
          oauthConnected: outlookOauthConnected,
          oauthEmail: outlookOauthEmail,
        },
        gmail: {
          mode: cfg.gmail.mode,
          clientId: googleClientId || null,
          clientIdSet: Boolean(googleClientId) && Boolean(getGoogleClientSecret()),
          oauthConnected: gmailOauthConnected,
          oauthEmail: gmailOauthEmail,
        },
      },
    });
  });

  // ---- OTP ---------------------------------------------------------------
  app.get("/v1/otp/latest", (req, res) => {
    const userId = String(req.userId);
    const maxAgeSec = Number(req.query.max_age ?? "120");
    const maxAgeMs = Number.isFinite(maxAgeSec) ? Math.max(1, Math.min(600, Math.floor(maxAgeSec))) * 1000 : 120_000;
    const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
    const account = typeof req.query.account === "string" ? req.query.account : undefined;
    const providers = parseProviders(typeof req.query.providers === "string" ? req.query.providers : undefined);
    // Reason: return the full valid list (best-first) so the popup can let the
    // user page through multiple in-window codes; `item` stays for compatibility.
    const items = store.validList({ userId, providers, account, maxAgeMs, domain });
    res.json({ ok: true, item: items[0] ?? null, items });
  });

  app.post("/v1/otp/consume", (req, res) => {
    const userId = String(req.userId);
    const Body = z.object({ id: z.string().min(8) });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const ok = store.consume(body.data.id, userId);
    res.json({ ok });
  });

  app.get("/v1/otp/list", (req, res) => {
    const userId = String(req.userId);
    res.json({ ok: true, items: store.list(20, userId) });
  });

  // ---- QQ ----------------------------------------------------------------
  app.post("/v1/qq/config", async (req, res) => {
    const Body = z.object({ email: z.string().email(), authCode: z.string().min(4) });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    // Verify the credentials can actually log in before saving (hard block).
    const v = await verifyImap({
      host: "imap.qq.com",
      port: 993,
      secure: true,
      user: body.data.email,
      pass: body.data.authCode,
    });
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const mgr = await mgrFor(req);
    await secretSet(mgr.secretKeyFor("qq", body.data.email), body.data.authCode);
    await mgr.addQqAccount(body.data.email);
    res.json({ ok: true });
  });

  app.post("/v1/qq/remove", async (req, res) => {
    const Body = z.object({ email: z.string().email() });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const mgr = await mgrFor(req);
    await mgr.removeQqAccount(body.data.email);
    res.json({ ok: true });
  });

  app.post("/v1/qq/clear", async (req, res) => {
    const mgr = await mgrFor(req);
    await mgr.clearQq();
    res.json({ ok: true });
  });

  // ---- reveal secret -----------------------------------------------------
  app.post("/v1/secret/reveal", async (req, res) => {
    const Body = z.object({
      kind: z.literal("qq"),
      email: z.string().email(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const mgr = await mgrFor(req);
    const value = await secretGet(mgr.secretKeyFor(body.data.kind, body.data.email));
    res.json({ ok: true, value: value ?? null });
  });

  // ---- Outlook -----------------------------------------------------------
  app.post("/v1/outlook/config", async (req, res) => {
    const Body = z.object({ mode: z.literal("oauth") });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const mgr = await mgrFor(req);

    // Client ID is an instance-wide admin setting; switching to OAuth mode just
    // flips the per-user mode flag. Sign-in uses the global client ID.
    if (!getOutlookClientId()) return res.status(400).json({ ok: false, error: "client_id_not_set" });
    await mgr.updateConfig((c) => {
      c.outlook.mode = "oauth";
    });
    res.json({ ok: true });
  });

  app.post("/v1/outlook/clear", async (req, res) => {
    const mgr = await mgrFor(req);
    await mgr.getOutlookOAuth().clearAuth();
    await mgr.updateConfig((c) => {
      c.outlook.mode = "oauth";
    });
    res.json({ ok: true });
  });

  app.post("/v1/outlook/auth/start", async (req, res) => {
    try {
      const mgr = await mgrFor(req);
      const dc = await mgr.getOutlookOAuth().startDeviceCode();
      res.json({ ok: true, deviceCode: dc });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  app.post("/v1/outlook/auth/poll", async (req, res) => {
    try {
      const mgr = await mgrFor(req);
      const r = await mgr.getOutlookOAuth().pollDeviceCodeOnce();
      await mgr.reconcile();
      res.json({ ok: true, result: r });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  // ---- Gmail ---------------------------------------------------------------
  app.post("/v1/gmail/config", async (req, res) => {
    const Body = z.object({ mode: z.literal("oauth") });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const mgr = await mgrFor(req);

    // Client ID and secret are instance-wide admin settings.
    if (!getGoogleClientId() || !getGoogleClientSecret()) {
      return res.status(400).json({ ok: false, error: "google_credentials_not_set" });
    }
    await mgr.updateConfig((c) => {
      c.gmail.mode = "oauth";
    });
    res.json({ ok: true });
  });

  app.post("/v1/gmail/clear", async (req, res) => {
    const mgr = await mgrFor(req);
    await mgr.getGmailOAuth().clearAuth();
    await mgr.updateConfig((c) => {
      c.gmail.mode = "oauth";
    });
    res.json({ ok: true });
  });

  app.post("/v1/gmail/auth/start", async (req, res) => {
    try {
      const mgr = await mgrFor(req);
      const dc = await mgr.getGmailOAuth().startDeviceCode();
      res.json({ ok: true, deviceCode: dc });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  app.post("/v1/gmail/auth/poll", async (req, res) => {
    try {
      const mgr = await mgrFor(req);
      const r = await mgr.getGmailOAuth().pollDeviceCodeOnce();
      await mgr.reconcile();
      res.json({ ok: true, result: r });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  // Standard OAuth authorization code flow (for browser-based sign-in).
  app.post("/v1/gmail/auth/complete", async (req, res) => {
    const Body = z.object({ code: z.string().min(1), redirectUri: z.string().min(1) });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    try {
      const mgr = await mgrFor(req);
      const r = await mgr.getGmailOAuth().exchangeCodeForTokens(body.data.code, body.data.redirectUri);
      await mgr.reconcile();
      res.json({ ok: true, result: { status: "success", token: r } });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  // OAuth callback — Google redirects here after user grants consent.
  // The `state` query param carries the user's auth token.
  app.get("/v1/gmail/auth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const error = typeof req.query.error === "string" ? req.query.error : "";

    if (error) {
      return res.status(400).send(`<html><body><h2>Authorization Failed</h2><p>${error}</p></body></html>`);
    }
    if (!code || !state) {
      return res.status(400).send(`<html><body><h2>Missing Parameters</h2><p>code and state are required.</p></body></html>`);
    }

    const userId = resolveSession(state);
    if (!userId) {
      return res.status(401).send(`<html><body><h2>Invalid Session</h2><p>Your session has expired. Please try again.</p></body></html>`);
    }

    try {
      const mgr = await registry.getOrCreate(userId);
      const redirectUri = "https://www.qiyi.click/otp/v1/gmail/auth/callback";
      const r = await mgr.getGmailOAuth().exchangeCodeForTokens(code, redirectUri);
      await mgr.reconcile();
      res.status(200).send(`<html><body><h2>Gmail Connected!</h2><p>You can close this tab and return to the extension.</p></body></html>`);
    } catch (e) {
      res.status(400).send(`<html><body><h2>Error</h2><p>${String((e as any)?.message || e)}</p></body></html>`);
    }
  });

  // ---- Gmail Pub/Sub -------------------------------------------------------

  // Pub/Sub push webhook — Google sends new-mail notifications here.
  // This endpoint is NOT behind requireAuth; it uses OIDC token verification instead.
  app.post("/v1/gmail/pubsub", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    try {
      // Verify OIDC token from Google Pub/Sub.
      const token = extractBearerToken(String(req.headers.authorization || ""));
      if (!token) {
        return res.status(401).json({ ok: false, error: "missing_bearer_token" });
      }
      const verified = await verifyGoogleOidcToken(token, getPubSubAudience());
      const pushEmail = verified.payload.email;
      if (!pushEmail) {
        return res.status(403).json({ ok: false, error: "no_email_in_token" });
      }

      // Decode the Pub/Sub message body (express.raw() gives us a Buffer).
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);
      const envelope = JSON.parse(rawBody) as {
        message?: { data?: string; attributes?: Record<string, string> };
        subscription?: string;
      };
      const dataB64 = envelope.message?.data ?? "";
      const decoded = Buffer.from(dataB64, "base64").toString("utf8");
      const payload = JSON.parse(decoded) as { emailAddress?: string; historyId?: string };

      const emailAddress = payload.emailAddress ?? pushEmail;
      const historyId = String(payload.historyId ?? "");
      if (!historyId) {
        return res.status(200).json({ ok: true, skipped: "no_history_id" });
      }

      // Find the user who owns this Gmail account.
      let targetUserId: string | null = null;
      for (const uid of await listUserIds()) {
        const mgr = await registry.getOrCreate(uid);
        const email = await mgr.getGmailOAuth().getAccountEmail();
        if (email === emailAddress) {
          targetUserId = uid;
          break;
        }
      }

      if (!targetUserId) {
        console.warn(`[gmail-pubsub] no user found for ${emailAddress}`);
        return res.status(200).json({ ok: true, skipped: "unknown_account" });
      }

      const mgr = await registry.getOrCreate(targetUserId);
      await mgr.getGmailOAuth().handlePubSubNotification(historyId);
      res.status(200).json({ ok: true });
    } catch (e) {
      const msg = String((e as any)?.message || e);
      console.error(`[gmail-pubsub] push handler error: ${msg}`);
      // Return 200 even on processing errors to avoid Pub/Sub retries for transient issues.
      res.status(200).json({ ok: false, error: msg });
    }
  });

  // Configure Pub/Sub for Gmail (enable/disable, set topic name).
  app.post("/v1/gmail/pubsub/config", async (req, res) => {
    const Body = z.object({
      pubsubEnabled: z.boolean(),
      topicName: z.string().min(1).optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const mgr = await mgrFor(req);
    await mgr.updateConfig((c) => {
      c.gmail.pubsubEnabled = body.data.pubsubEnabled;
      if (body.data.topicName !== undefined) c.gmail.topicName = body.data.topicName;
    });
    await mgr.reconcile();
    res.json({ ok: true });
  });

  // Register Gmail watch (call users.watch on the Gmail API).
  app.post("/v1/gmail/pubsub/start", async (req, res) => {
    try {
      const mgr = await mgrFor(req);
      const topicName = mgr.config.gmail.topicName;
      if (!topicName) {
        return res.status(400).json({ ok: false, error: "topic_name_not_configured" });
      }
      const result = await mgr.getGmailOAuth().startWatch(topicName);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  // Pub/Sub watch status.
  app.get("/v1/gmail/pubsub/status", async (req, res) => {
    const mgr = await mgrFor(req);
    const pubsub = mgr.getGmailOAuth().pubsubStatus();
    res.json({
      ok: true,
      pubsubEnabled: mgr.config.gmail.pubsubEnabled,
      topicName: mgr.config.gmail.topicName ?? null,
      ...pubsub,
    });
  });

  // ---- admin API (token-gated via requireAdmin) --------------------------
  app.get("/v1/admin/stats", requireAdmin, (_req, res) => {
    const now = Date.now();
    const dayStart = now - (now % 86_400_000); // approx local-naive day bucket (UTC)
    const week = now - 7 * 86_400_000;
    const totalUsers = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const todayNew = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?").get(dayStart) as { n: number }).n;
    const activ7 = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?").get(week) as { n: number }).n;
    const disabled = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 1").get() as { n: number }).n;
    res.json({
      ok: true,
      users: { total: totalUsers, todayNew, active7d: activ7, disabled },
      invites: inviteStats(),
      requireInvite: isInviteRequired(),
      outlookClientId: getOutlookClientId(),
      googleClientId: getGoogleClientId(),
      pubsubAudience: getPubSubAudience(),
    });
  });

  app.get("/v1/admin/invites", requireAdmin, (_req, res) => {
    // Attach the consumer's username for display.
    const items = listInvites().map((iv) => {
      let usedByName: string | null = null;
      if (iv.usedBy) {
        const u = db.prepare("SELECT username FROM users WHERE id = ?").get(iv.usedBy) as { username: string } | undefined;
        usedByName = u ? u.username : iv.usedBy;
      }
      return { ...iv, usedByName };
    });
    res.json({ ok: true, items });
  });

  app.post("/v1/admin/invites", requireAdmin, (req, res) => {
    const Body = z.object({ count: z.number().int().min(1).max(100).default(1), note: z.string().max(200).optional() });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const made = createInvites(body.data.count, body.data.note);
    res.json({ ok: true, codes: made.map((m) => m.code) });
  });

  app.post("/v1/admin/invites/revoke", requireAdmin, (req, res) => {
    const Body = z.object({ code: z.string().min(1) });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    res.json({ ok: revokeInvite(body.data.code.toUpperCase()) });
  });

  app.post("/v1/admin/settings", requireAdmin, (req, res) => {
    const Body = z.object({
      requireInvite: z.boolean().optional(),
      // Microsoft App (client) ID for Outlook OAuth. Empty string clears it.
      outlookClientId: z.string().trim().max(200).optional(),
      // Google OAuth client credentials for Gmail. Empty string clears them.
      googleClientId: z.string().trim().max(200).optional(),
      googleClientSecret: z.string().trim().max(200).optional(),
      // Pub/Sub Push OIDC audience (your agent's public URL).
      pubsubAudience: z.string().trim().max(500).optional(),
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    if (body.data.requireInvite !== undefined) setInviteRequired(body.data.requireInvite);
    if (body.data.outlookClientId !== undefined) setOutlookClientId(body.data.outlookClientId);
    if (body.data.googleClientId !== undefined) setGoogleClientId(body.data.googleClientId);
    if (body.data.googleClientSecret !== undefined) setGoogleClientSecret(body.data.googleClientSecret);
    if (body.data.pubsubAudience !== undefined) setPubSubAudience(body.data.pubsubAudience);
    res.json({
      ok: true,
      requireInvite: isInviteRequired(),
      outlookClientId: getOutlookClientId(),
      googleClientId: getGoogleClientId(),
      pubsubAudience: getPubSubAudience(),
    });
  });

  // Summarize the mailboxes a user has bound (from their per-user config).
  async function userMailboxes(userId: string) {
    const cfg = await loadConfig(userId);
    const mgr = await registry.getOrCreate(userId);
    const out: Array<{ type: string; email?: string }> = [];
    for (const a of cfg.qq.accounts) out.push({ type: "qq", email: a.email });
    if (cfg.outlook.mode === "oauth" && getOutlookClientId() && (await mgr.getOutlookOAuth().hasRefreshToken())) {
      const email = await mgr.getOutlookOAuth().getAccountEmail();
      out.push({ type: "outlook_oauth", email: email || undefined });
    }
    if (cfg.gmail.mode === "oauth" && getGoogleClientId() && getGoogleClientSecret() && (await mgr.getGmailOAuth().hasRefreshToken())) {
      const email = await mgr.getGmailOAuth().getAccountEmail();
      out.push({ type: "gmail_oauth", email: email || undefined });
    }
    return out;
  }

  app.get("/v1/admin/users", requireAdmin, async (_req, res) => {
    const users = await listUsers();
    const items = await Promise.all(
      users.map(async (u) => ({
        id: u.id,
        username: u.username,
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        disabled: u.disabled,
        mailboxes: await userMailboxes(u.id),
      }))
    );
    res.json({ ok: true, items });
  });

  app.post("/v1/admin/users/disable", requireAdmin, async (req, res) => {
    const Body = z.object({ userId: z.string().min(1), disabled: z.boolean() });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const target = await getUser(body.data.userId);
    if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });

    setUserDisabled(body.data.userId, body.data.disabled);
    if (body.data.disabled) {
      // Kick the user offline and stop their mailbox polling (data is kept).
      destroyUserSessions(body.data.userId);
      await registry.removeUser(body.data.userId);
    } else {
      // Re-enable: rebuild their providers/watchers.
      await registry.getOrCreate(body.data.userId);
    }
    res.json({ ok: true });
  });

  // ---- admin static page -------------------------------------------------
  // Served from agent/admin/index.html (../admin relative to this module, both
  // in tsx/src and compiled dist). Browser-opened, so no client-header gate.
  const adminDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin");
  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(adminDir, "index.html"));
  });

  const server = app.listen(AGENT_PORT, AGENT_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[otp-agent] listening on http://${AGENT_HOST}:${AGENT_PORT}`
    );
  });

  return { app, server, store, registry };
}
