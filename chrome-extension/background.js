importScripts("i18n.js");
const { t, getUiLang } = globalThis.OtpI18n;

// Map a content-script fill error code to a localized toast message.
function translateFillError(lang, code) {
  if (code === "no_otp_field" || code === "err_no_otp_field") return t(lang, "err_no_otp_field");
  if (code === "invalid_code" || code === "err_invalid_code") return t(lang, "err_invalid_code");
  return t(lang, "toast_fill_failed");
}

const CLIENT_HEADER_NAME = "x-otp-agent-client";
const CLIENT_HEADER_VALUE = "email-otp-autofill";

const DEFAULTS = {
  agentBaseUrl: "https://otp.razet.me",
  maxAgeSec: 120,
  providers: ["qq", "outlook", "gmail"]
};

async function getSettings() {
  const raw = await chrome.storage.local.get([...Object.keys(DEFAULTS), "authToken"]);
  return {
    agentBaseUrl: raw.agentBaseUrl || DEFAULTS.agentBaseUrl,
    maxAgeSec: Number.isFinite(raw.maxAgeSec) ? raw.maxAgeSec : DEFAULTS.maxAgeSec,
    providers: Array.isArray(raw.providers) && raw.providers.length ? raw.providers : DEFAULTS.providers,
    authToken: typeof raw.authToken === "string" ? raw.authToken : ""
  };
}

async function agentFetch(path, init = {}) {
  const s = await getSettings();
  const url = s.agentBaseUrl.replace(/\/$/, "") + path;
  const headers = new Headers(init.headers || {});
  headers.set(CLIENT_HEADER_NAME, CLIENT_HEADER_VALUE);
  // Multi-tenant session token from login.
  if (s.authToken) headers.set("authorization", `Bearer ${s.authToken}`);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && json.error) ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// Fetch all currently-valid OTPs for the active tab, best match first. Returns
// both the top pick (`item`) and the full list (`items`) so the popup can page
// through multiple in-window codes. Falls back to wrapping a lone `item` for
// older agents that don't return `items`.
async function fetchOtpsForTab(tabUrl) {
  const s = await getSettings();
  let domain = "";
  try {
    domain = new URL(tabUrl).hostname;
  } catch {
    domain = "";
  }
  const q = new URLSearchParams();
  q.set("max_age", String(s.maxAgeSec));
  if (domain) q.set("domain", domain);
  if (s.providers && s.providers.length) q.set("providers", s.providers.join(","));
  const json = await agentFetch(`/v1/otp/latest?${q.toString()}`, { method: "GET" });
  const item = json.item || null;
  const items = Array.isArray(json.items) ? json.items : item ? [item] : [];
  return { item, items };
}

async function fetchLatestOtpForTab(tabUrl) {
  const { item } = await fetchOtpsForTab(tabUrl);
  return item;
}

// --- New-OTP badge on the toolbar icon -------------------------------------

const POLL_ALARM = "otp-poll";
const BADGE_COLOR = "#e53935";

async function setUnreadBadge(count) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    // setBadgeTextColor is not available on all Chrome versions.
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
  }
}

// Poll the agent for OTPs newer than the last time the user looked, and badge
// the toolbar icon with the unread count. Silent on failure (agent down/unset).
async function pollForNewOtp() {
  try {
    const s = await getSettings();
    const json = await agentFetch("/v1/otp/list", { method: "GET" });
    const items = (json && json.items) || [];
    const { lastSeenOtpTs = 0 } = await chrome.storage.local.get(["lastSeenOtpTs"]);
    const now = Date.now();
    const maxAgeMs = Math.max(1, s.maxAgeSec) * 1000;
    // Reason: an OTP is "unread" only if it arrived after the user last
    // viewed/filled AND is still within its validity window. Expired codes must
    // not keep the badge lit. We no longer consume on fill, so consumedAt is not
    // used for badge state — "seen" (lastSeenOtpTs) is the single source.
    const unread = items.filter(
      (it) =>
        it &&
        Number(it.receivedAt) > lastSeenOtpTs &&
        now - Number(it.receivedAt) <= (it.ttlSec && it.ttlSec > 0 ? it.ttlSec * 1000 : maxAgeMs)
    );
    await setUnreadBadge(unread.length);
  } catch {
    // Agent unreachable or not configured — leave the badge untouched.
  }
}

// Mark everything currently in the store as seen and clear the badge.
async function markAllOtpSeen() {
  await chrome.storage.local.set({ lastSeenOtpTs: Date.now() });
  await setUnreadBadge(0);
}

function ensurePollAlarm() {
  // 0.5 min is the practical floor for an unpacked extension; OTPs are
  // short-lived, so notice them well before they expire.
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensurePollAlarm();
  pollForNewOtp();
});
chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm();
  pollForNewOtp();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollForNewOtp();
});

// Also run once whenever the service worker spins up.
ensurePollAlarm();
pollForNewOtp();

// Fill the OTP on the active tab. `codeOverride` lets the popup fill the code
// the user is currently viewing (which may not be the newest one when paging
// through multiple valid codes); without it we fall back to the latest pick.
async function fillOnActiveTab(codeOverride) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "no_active_tab" };

  const lang = await getUiLang();

  let code = typeof codeOverride === "string" ? codeOverride.trim().replace(/[\s-]+/g, "") : "";
  if (!code) {
    const otp = await fetchLatestOtpForTab(tab.url || "");
    code = otp && otp.code ? otp.code : "";
  }
  if (!code) {
    await chrome.tabs.sendMessage(tab.id, { type: "OTP_TOAST", level: "info", message: t(lang, "toast_no_otp") });
    return { ok: false, error: "no_otp" };
  }

  const result = await chrome.tabs.sendMessage(tab.id, { type: "OTP_FILL", code });
  if (result && result.ok) {
    // Reason: we intentionally do NOT consume the OTP here. The code must stay
    // visible in the popup for its whole validity window (maxAgeSec) even after
    // filling — consuming would drop it from /v1/otp/latest immediately.
    // Marking it "seen" only clears the unread badge; it stays fetchable.
    await markAllOtpSeen();
    return { ok: true };
  }

  await chrome.tabs.sendMessage(tab.id, {
    type: "OTP_TOAST",
    level: "error",
    message: translateFillError(lang, result && result.error ? String(result.error) : "")
  });
  return { ok: false, error: (result && result.error) ? String(result.error) : "fill_failed" };
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "fill_otp") {
    fillOnActiveTab().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "BG_FETCH_LATEST") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const { item, items } = await fetchOtpsForTab((tab && tab.url) || "");
      // Opening the popup counts as seeing the latest codes — clear the badge.
      await markAllOtpSeen();
      sendResponse({ ok: true, otp: item, otps: items });
      return;
    }

    if (msg.type === "BG_FILL_NOW") {
      const r = await fillOnActiveTab(typeof msg.code === "string" ? msg.code : undefined);
      sendResponse(r);
      return;
    }

    if (msg.type === "BG_AGENT_STATUS") {
      const json = await agentFetch("/v1/status", { method: "GET" });
      sendResponse({ ok: true, status: json });
      return;
    }

    // --- multi-tenant auth ---
    if (msg.type === "BG_AUTH_REGISTER" || msg.type === "BG_AUTH_LOGIN") {
      const path = msg.type === "BG_AUTH_REGISTER" ? "/v1/auth/register" : "/v1/auth/login";
      const payload = { username: msg.username, password: msg.password };
      if (msg.type === "BG_AUTH_REGISTER" && msg.inviteCode) payload.inviteCode = msg.inviteCode;
      const json = await agentFetch(path, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      // Persist the session token; agentFetch attaches it on subsequent calls.
      if (json && json.token) await chrome.storage.local.set({ authToken: json.token });
      sendResponse({ ok: true, user: json.user });
      return;
    }

    if (msg.type === "BG_AUTH_LOGOUT") {
      try {
        await agentFetch("/v1/auth/logout", { method: "POST", body: JSON.stringify({}) });
      } catch {
        // ignore — clear locally regardless
      }
      await chrome.storage.local.remove("authToken");
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "BG_AUTH_ME") {
      try {
        const json = await agentFetch("/v1/auth/me", { method: "GET" });
        sendResponse({ ok: true, user: json.user });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return;
    }

    if (msg.type === "BG_QQ_CONFIG") {
      const { email, authCode } = msg;
      const json = await agentFetch("/v1/qq/config", {
        method: "POST",
        body: JSON.stringify({ email, authCode })
      });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_QQ_CLEAR") {
      const json = await agentFetch("/v1/qq/clear", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_QQ_REMOVE") {
      const json = await agentFetch("/v1/qq/remove", {
        method: "POST",
        body: JSON.stringify({ email: msg.email })
      });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_REVEAL_SECRET") {
      const json = await agentFetch("/v1/secret/reveal", {
        method: "POST",
        body: JSON.stringify({ kind: "qq", email: msg.email })
      });
      sendResponse({ ok: true, value: json.value });
      return;
    }

    if (msg.type === "BG_OUTLOOK_CONFIG") {
      const json = await agentFetch("/v1/outlook/config", {
        method: "POST",
        body: JSON.stringify(msg.payload || {})
      });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_OUTLOOK_CLEAR") {
      const json = await agentFetch("/v1/outlook/clear", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_OUTLOOK_AUTH_START") {
      const json = await agentFetch("/v1/outlook/auth/start", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, deviceCode: json.deviceCode });
      return;
    }

    if (msg.type === "BG_OUTLOOK_AUTH_POLL") {
      const json = await agentFetch("/v1/outlook/auth/poll", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, result: json.result });
      return;
    }

    // --- Gmail OAuth ---
    if (msg.type === "BG_GMAIL_CONFIG") {
      const json = await agentFetch("/v1/gmail/config", {
        method: "POST",
        body: JSON.stringify(msg.payload || {})
      });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_GMAIL_CLEAR") {
      const json = await agentFetch("/v1/gmail/clear", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, result: json });
      return;
    }

    if (msg.type === "BG_GMAIL_AUTH_START") {
      const json = await agentFetch("/v1/gmail/auth/start", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, deviceCode: json.deviceCode });
      return;
    }

    if (msg.type === "BG_GMAIL_AUTH_POLL") {
      const json = await agentFetch("/v1/gmail/auth/poll", { method: "POST", body: JSON.stringify({}) });
      sendResponse({ ok: true, result: json.result });
      return;
    }

    // Standard OAuth authorization code exchange (for browser-based sign-in).
    if (msg.type === "BG_GMAIL_AUTH_COMPLETE") {
      const json = await agentFetch("/v1/gmail/auth/complete", {
        method: "POST",
        body: JSON.stringify({ code: msg.code, redirectUri: msg.redirectUri })
      });
      sendResponse({ ok: true, result: json.result });
      return;
    }
  })()
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));

  // Keep the message channel open for async.
  return true;
});
