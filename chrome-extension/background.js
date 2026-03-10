const CLIENT_HEADER_NAME = "x-otp-agent-client";
const CLIENT_HEADER_VALUE = "email-otp-autofill";

const DEFAULTS = {
  agentBaseUrl: "http://127.0.0.1:17373",
  maxAgeSec: 120,
  providers: ["qq", "outlook"],
  autoConsume: true
};

async function getSettings() {
  const raw = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return {
    agentBaseUrl: raw.agentBaseUrl || DEFAULTS.agentBaseUrl,
    maxAgeSec: Number.isFinite(raw.maxAgeSec) ? raw.maxAgeSec : DEFAULTS.maxAgeSec,
    providers: Array.isArray(raw.providers) && raw.providers.length ? raw.providers : DEFAULTS.providers,
    autoConsume: raw.autoConsume === false ? false : DEFAULTS.autoConsume
  };
}

async function agentFetch(path, init = {}) {
  const s = await getSettings();
  const url = s.agentBaseUrl.replace(/\/$/, "") + path;
  const headers = new Headers(init.headers || {});
  headers.set(CLIENT_HEADER_NAME, CLIENT_HEADER_VALUE);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && json.error) ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function fetchLatestOtpForTab(tabUrl) {
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
  return json.item || null;
}

async function consumeOtp(id) {
  await agentFetch("/v1/otp/consume", { method: "POST", body: JSON.stringify({ id }) });
}

async function fillOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "no_active_tab" };

  const otp = await fetchLatestOtpForTab(tab.url || "");
  if (!otp || !otp.code) {
    await chrome.tabs.sendMessage(tab.id, { type: "OTP_TOAST", level: "info", message: "No recent OTP found." });
    return { ok: false, error: "no_otp" };
  }

  const result = await chrome.tabs.sendMessage(tab.id, { type: "OTP_FILL", code: otp.code });
  if (result && result.ok) {
    const s = await getSettings();
    if (s.autoConsume && otp.id) {
      try {
        await consumeOtp(otp.id);
      } catch {
        // ignore consume errors
      }
    }
    return { ok: true };
  }

  await chrome.tabs.sendMessage(tab.id, {
    type: "OTP_TOAST",
    level: "error",
    message: (result && result.error) ? String(result.error) : "Failed to fill OTP."
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
      const otp = await fetchLatestOtpForTab((tab && tab.url) || "");
      sendResponse({ ok: true, otp });
      return;
    }

    if (msg.type === "BG_FILL_NOW") {
      const r = await fillOnActiveTab();
      sendResponse(r);
      return;
    }

    if (msg.type === "BG_AGENT_STATUS") {
      const json = await agentFetch("/v1/status", { method: "GET" });
      sendResponse({ ok: true, status: json });
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
  })()
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));

  // Keep the message channel open for async.
  return true;
});

