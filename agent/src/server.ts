import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { z } from "zod";

import { AGENT_HOST, AGENT_PORT, MASTER_KEY } from "./constants.js";
import { cors, noStore, requireClientHeader } from "./http/middleware.js";
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
import { isInviteRequired, setInviteRequired, getOutlookClientId, setOutlookClientId } from "./storage/settings.js";

function parseProviders(raw: string | undefined): ("qq" | "outlook")[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<"qq" | "outlook">();
  for (const p of parts) {
    if (p === "qq" || p === "outlook") set.add(p);
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
  app.use(express.json({ limit: "256kb" }));
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

  // Gate: every /v1 route except status, auth, and admin requires a valid user
  // session. Admin routes have their own requireAdmin guard.
  app.use((req, res, next) => {
    const p = req.path;
    if (!p.startsWith("/v1/")) return next();
    if (p === "/v1/status" || p.startsWith("/v1/auth/") || p.startsWith("/v1/admin/")) return next();
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
    const item = store.latest({ userId, providers, account, maxAgeMs, domain });
    res.json({ ok: true, item });
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
    });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    if (body.data.requireInvite !== undefined) setInviteRequired(body.data.requireInvite);
    if (body.data.outlookClientId !== undefined) setOutlookClientId(body.data.outlookClientId);
    res.json({
      ok: true,
      requireInvite: isInviteRequired(),
      outlookClientId: getOutlookClientId(),
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
