import express from "express";
import { z } from "zod";

import { AGENT_HOST, AGENT_PORT } from "./constants.js";
import { cors, requireClientHeader } from "./http/middleware.js";
import { OtpStore } from "./otp/store.js";
import { ProviderManager } from "./providers/manager.js";
import { secretGet, secretSet } from "./storage/secrets.js";

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
  const app = express();
  app.disable("x-powered-by");
  app.use(cors);
  app.use(express.json({ limit: "256kb" }));
  app.use(requireClientHeader);

  const store = new OtpStore();
  const mgr = await ProviderManager.create(store);
  await mgr.reconcile();

  app.get("/v1/status", async (_req, res) => {
    const cfg = mgr.config;
    const qqConfigured = cfg.qq.email ? Boolean(await secretGet(`qq:${cfg.qq.email}`)) : false;
    const outlookOauthConnected =
      cfg.outlook.mode === "oauth" ? await mgr.getOutlookOAuth().hasRefreshToken() : false;
    const outlookImapConfigured =
      cfg.outlook.mode === "imap" && cfg.outlook.imapEmail
        ? Boolean(await secretGet(`outlook_imap:${cfg.outlook.imapEmail}`))
        : false;
    res.json({
      ok: true,
      agent: { host: AGENT_HOST, port: AGENT_PORT },
      config: {
        pollIntervalMs: cfg.pollIntervalMs,
        qq: { email: cfg.qq.email ?? null, configured: qqConfigured },
        outlook: {
          mode: cfg.outlook.mode,
          clientId: cfg.outlook.clientId ?? null,
          clientIdSet: Boolean(cfg.outlook.clientId),
          imapEmail: cfg.outlook.imapEmail ?? null,
          imapConfigured: outlookImapConfigured,
          oauthConnected: outlookOauthConnected,
        },
      },
    });
  });

  app.get("/v1/otp/latest", (req, res) => {
    const maxAgeSec = Number(req.query.max_age ?? "120");
    const maxAgeMs = Number.isFinite(maxAgeSec) ? Math.max(1, Math.min(600, Math.floor(maxAgeSec))) * 1000 : 120_000;
    const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
    const providers = parseProviders(typeof req.query.providers === "string" ? req.query.providers : undefined);
    const item = store.latest({ providers, maxAgeMs, domain });
    res.json({ ok: true, item });
  });

  app.post("/v1/otp/consume", (req, res) => {
    const Body = z.object({ id: z.string().min(8) });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const ok = store.consume(body.data.id);
    res.json({ ok });
  });

  app.get("/v1/otp/list", (_req, res) => {
    res.json({ ok: true, items: store.list(20) });
  });

  // QQ
  app.post("/v1/qq/config", async (req, res) => {
    const Body = z.object({ email: z.string().email(), authCode: z.string().min(4) });
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const { email, authCode } = body.data;
    await secretSet(`qq:${email}`, authCode);
    await mgr.updateConfig((c) => {
      c.qq.email = email;
    });
    res.json({ ok: true });
  });

  app.post("/v1/qq/clear", async (_req, res) => {
    await mgr.clearQq();
    res.json({ ok: true });
  });

  // Outlook config (OAuth or IMAP)
  app.post("/v1/outlook/config", async (req, res) => {
    const Body = z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("oauth"), clientId: z.string().min(8) }),
      z.object({ mode: z.literal("imap"), email: z.string().email(), appPassword: z.string().min(4) }),
    ]);
    const body = Body.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: "bad_request" });
    const data = body.data;

    if (data.mode === "oauth") {
      await mgr.updateConfig((c) => {
        c.outlook.mode = "oauth";
        c.outlook.clientId = data.clientId;
      });
      res.json({ ok: true });
      return;
    }

    await secretSet(`outlook_imap:${data.email}`, data.appPassword);
    await mgr.updateConfig((c) => {
      c.outlook.mode = "imap";
      c.outlook.imapEmail = data.email;
    });
    res.json({ ok: true });
  });

  app.post("/v1/outlook/clear", async (_req, res) => {
    await mgr.getOutlookOAuth().clearAuth();
    await mgr.clearOutlookImap();
    await mgr.updateConfig((c) => {
      c.outlook.clientId = undefined;
      c.outlook.mode = "oauth";
    });
    res.json({ ok: true });
  });

  app.post("/v1/outlook/auth/start", async (_req, res) => {
    try {
      const dc = await mgr.getOutlookOAuth().startDeviceCode();
      res.json({ ok: true, deviceCode: dc });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  app.post("/v1/outlook/auth/poll", async (_req, res) => {
    try {
      const r = await mgr.getOutlookOAuth().pollDeviceCodeOnce();
      await mgr.reconcile();
      res.json({ ok: true, result: r });
    } catch (e) {
      res.status(400).json({ ok: false, error: String((e as any)?.message || e) });
    }
  });

  const server = app.listen(AGENT_PORT, AGENT_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[otp-agent] listening on http://${AGENT_HOST}:${AGENT_PORT}`);
  });

  return { app, server, store, mgr };
}
