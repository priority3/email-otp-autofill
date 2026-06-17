const { t, getUiLang, setUiLang, applyStaticI18n } = globalThis.OtpI18n;

let LANG = "en";
// Shorthand: translate with the current language.
const T = (key, vars) => t(LANG, key, vars);

function $(id) {
  return document.getElementById(id);
}

async function bg(message) {
  return await chrome.runtime.sendMessage(message);
}

function setMsg(id, text) {
  const el = $(id);
  if (el) el.textContent = text || "";
}

function setAgentStatus(ok, detail) {
  setMsg("agentStatus", T(ok ? "agent_ok_detail" : "agent_down_detail", { detail: detail || "" }));
}

// Eye icons for the per-field password visibility toggle (feather-style SVG,
// stroke=currentColor so they inherit the muted/hover color from CSS).
const EYE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function setPwdVisible(input, btn, visible) {
  input.type = visible ? "text" : "password";
  // Show the "eye-off" icon while visible (clicking it hides again), and vice versa.
  btn.innerHTML = visible ? EYE_OFF_ICON : EYE_ICON;
  btn.setAttribute("aria-label", T(visible ? "hide_password" : "show_password"));
}

// Wire up every .pwd-toggle button to its input (via data-toggle="<inputId>").
function initPwdToggles() {
  document.querySelectorAll(".pwd-toggle").forEach((btn) => {
    const input = $(btn.getAttribute("data-toggle"));
    if (!input) return;
    setPwdVisible(input, btn, false);
    btn.addEventListener("click", () => {
      setPwdVisible(input, btn, input.type === "password");
    });
  });
}

// Refresh the toggle aria-labels after a language switch (icons stay as-is).
function refreshPwdToggleLabels() {
  document.querySelectorAll(".pwd-toggle").forEach((btn) => {
    const input = $(btn.getAttribute("data-toggle"));
    if (!input) return;
    btn.setAttribute("aria-label", T(input.type === "text" ? "hide_password" : "show_password"));
  });
}

// Rich-text hints (contain HTML) are set here, not via applyStaticI18n.
function applyRichI18n() {
  const map = { baseUrlHint: "base_url_hint", qqHowto: "qq_howto", clientIdHowto: "client_id_howto" };
  for (const id of Object.keys(map)) {
    const el = $(id);
    if (el) el.innerHTML = T(map[id]);
  }
}

function applyLang(lang) {
  LANG = lang;
  applyStaticI18n(document, LANG);
  applyRichI18n();
  refreshPwdToggleLabels();
  const sel = $("uiLang");
  if (sel) sel.value = LANG;
}

function originPatternFromBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function loadLastConfig() {
  const raw = await chrome.storage.local.get([
    "lastQqEmail",
    "lastOutlookMode",
    "lastOutlookClientId",
    "lastOutlookImapEmail"
  ]);

  if (raw.lastQqEmail && !$("qqEmail").value) $("qqEmail").value = raw.lastQqEmail;
  if (raw.lastOutlookMode) {
    $("outlookMode").value = raw.lastOutlookMode;
    renderOutlookMode($("outlookMode").value);
  }
  if (raw.lastOutlookClientId && !$("outlookClientId").value) $("outlookClientId").value = raw.lastOutlookClientId;
  if (raw.lastOutlookImapEmail && !$("outlookImapEmail").value) $("outlookImapEmail").value = raw.lastOutlookImapEmail;
}

async function loadExtSettings() {
  const raw = await chrome.storage.local.get(["agentBaseUrl", "agentApiKey", "maxAgeSec"]);
  $("agentBaseUrl").value = raw.agentBaseUrl || "http://127.0.0.1:17373";
  $("agentApiKey").value = raw.agentApiKey || "";
  $("maxAgeSec").value = String(Number.isFinite(raw.maxAgeSec) ? raw.maxAgeSec : 120);
}

async function saveExtSettings() {
  setMsg("saveExtMsg", T("saving"));
  const agentBaseUrl = $("agentBaseUrl").value.trim() || "http://127.0.0.1:17373";
  const agentApiKey = $("agentApiKey").value.trim();
  const maxAgeSec = Math.max(10, Math.min(600, Number($("maxAgeSec").value || "120")));

  const origin = originPatternFromBaseUrl(agentBaseUrl);
  let permGranted = true;
  // Localhost origin is already in host_permissions.
  if (origin && origin !== "http://127.0.0.1:17373/*") {
    try {
      // IMPORTANT: permissions.request must be called in a user gesture. Keep it before other awaits.
      permGranted = await chrome.permissions.request({ origins: [origin] });
    } catch {
      permGranted = false;
    }
  }

  try {
    await chrome.storage.local.set({ agentBaseUrl, agentApiKey, maxAgeSec });
  } catch (e) {
    setMsg("saveExtMsg", T("save_failed_with", { err: String(e && e.message ? e.message : e) }));
    return;
  }

  if (origin && origin !== "http://127.0.0.1:17373/*" && !permGranted) {
    setMsg("saveExtMsg", T("perm_not_granted", { origin }));
  } else {
    setMsg("saveExtMsg", T("saved"));
  }
  setTimeout(() => setMsg("saveExtMsg", ""), 2500);
  await refreshAgentStatus();
}

function renderOutlookMode(mode) {
  const oauthBox = $("outlookOauthBox");
  const imapBox = $("outlookImapBox");
  if (mode === "imap") {
    oauthBox.style.display = "none";
    imapBox.style.display = "block";
  } else {
    oauthBox.style.display = "block";
    imapBox.style.display = "none";
  }
}

async function refreshAgentStatus() {
  try {
    const r = await bg({ type: "BG_AGENT_STATUS" });
    if (!r || !r.ok) {
      const err = r && r.error ? String(r.error) : "";
      if (err === "unauthorized") setAgentStatus(false, T("need_api_key"));
      else if (err) setAgentStatus(false, err);
      else setAgentStatus(false, "");
      return;
    }

    setAgentStatus(true, `${r.status.agent.host}:${r.status.agent.port}`);

    const cfg = r.status.config || {};
    const cache = {};
    if (cfg.qq) {
      if (cfg.qq.email) {
        $("qqEmail").value = cfg.qq.email;
        cache.lastQqEmail = cfg.qq.email;
      }
      setMsg("qqState", T(cfg.qq.configured ? "configured" : "not_configured"));
    }

    if (cfg.outlook) {
      $("outlookMode").value = cfg.outlook.mode || "oauth";
      renderOutlookMode($("outlookMode").value);
      cache.lastOutlookMode = $("outlookMode").value;
      if (cfg.outlook.clientId) $("outlookClientId").value = cfg.outlook.clientId;
      if (cfg.outlook.clientId) cache.lastOutlookClientId = cfg.outlook.clientId;
      if (cfg.outlook.imapEmail) $("outlookImapEmail").value = cfg.outlook.imapEmail;
      if (cfg.outlook.imapEmail) cache.lastOutlookImapEmail = cfg.outlook.imapEmail;

      if ($("outlookMode").value === "oauth") {
        setMsg("outlookState", T(cfg.outlook.oauthConnected ? "oauth_connected" : "oauth_not_connected"));
      } else {
        setMsg("outlookState", T(cfg.outlook.imapConfigured ? "imap_configured" : "imap_not_configured"));
      }
    }

    await chrome.storage.local.set(cache);
  } catch (e) {
    setAgentStatus(false, String(e && e.message ? e.message : e));
  }
}

// Pre-fill stored credentials (masked as dots) so the user can see/copy them
// via the eye toggle. Values come from the agent's reveal endpoint.
async function revealStoredSecrets() {
  for (const [kind, inputId] of [["qq", "qqAuthCode"], ["outlook_imap", "outlookImapPass"]]) {
    try {
      const r = await bg({ type: "BG_REVEAL_SECRET", kind });
      if (r && r.ok && r.value) $(inputId).value = r.value;
    } catch {
      // ignore — agent down or secret not set
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  LANG = await getUiLang();
  applyLang(LANG);

  await loadExtSettings();
  await loadLastConfig();
  renderOutlookMode($("outlookMode").value);
  await refreshAgentStatus();
  await revealStoredSecrets();

  $("uiLang").addEventListener("change", async () => {
    const lang = $("uiLang").value;
    await setUiLang(lang);
    applyLang(lang);
    // Reason: re-render dynamic status strings in the new language.
    await refreshAgentStatus();
  });

  $("refreshStatus").addEventListener("click", refreshAgentStatus);
  $("saveExt").addEventListener("click", saveExtSettings);
  initPwdToggles();

  $("qqSave").addEventListener("click", async () => {
    setMsg("qqMsg", T("saving"));
    try {
      const email = $("qqEmail").value.trim();
      const authCode = $("qqAuthCode").value.trim();
      const r = await bg({ type: "BG_QQ_CONFIG", email, authCode });
      setMsg("qqMsg", r && r.ok ? T("saved") : T("failed_with", { err: r && r.error ? r.error : "" }));
      if (r && r.ok) {
        setMsg("qqState", T("configured"));
        await chrome.storage.local.set({ lastQqEmail: email });
      }
      await refreshAgentStatus();
    } catch (e) {
      setMsg("qqMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("qqMsg", ""), 2500);
  });

  $("qqClear").addEventListener("click", async () => {
    setMsg("qqMsg", T("clearing"));
    try {
      const r = await bg({ type: "BG_QQ_CLEAR" });
      setMsg("qqMsg", r && r.ok ? T("cleared") : T("failed"));
      await refreshAgentStatus();
    } catch (e) {
      setMsg("qqMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("qqMsg", ""), 2500);
  });

  $("outlookMode").addEventListener("change", () => {
    renderOutlookMode($("outlookMode").value);
  });

  $("outlookOauthSave").addEventListener("click", async () => {
    setMsg("outlookOauthMsg", T("saving"));
    try {
      const clientId = $("outlookClientId").value.trim();
      const r = await bg({ type: "BG_OUTLOOK_CONFIG", payload: { mode: "oauth", clientId } });
      setMsg("outlookOauthMsg", r && r.ok ? T("saved") : T("failed_with", { err: r && r.error ? r.error : "" }));
      if (r && r.ok) {
        setMsg("outlookState", T("oauth_not_connected"));
        await chrome.storage.local.set({ lastOutlookMode: "oauth", lastOutlookClientId: clientId });
      }
      await refreshAgentStatus();
    } catch (e) {
      setMsg("outlookOauthMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("outlookOauthMsg", ""), 2500);
  });

  $("outlookAuthStart").addEventListener("click", async () => {
    setMsg("deviceCodeMsg", T("starting"));
    try {
      const r = await bg({ type: "BG_OUTLOOK_AUTH_START" });
      if (!r || !r.ok) {
        setMsg("deviceCodeMsg", T("failed_with", { err: r && r.error ? r.error : "" }));
        return;
      }
      const dc = r.deviceCode;
      const link = dc.verification_uri_complete || dc.verification_uri;
      setMsg(
        "deviceCodeMsg",
        T("device_code_msg", { uri: dc.verification_uri, code: dc.user_code, sec: dc.expires_in })
      );
      if (link) chrome.tabs.create({ url: link });
    } catch (e) {
      setMsg("deviceCodeMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
  });

  $("outlookAuthPoll").addEventListener("click", async () => {
    setMsg("outlookOauthMsg", T("polling"));
    try {
      const r = await bg({ type: "BG_OUTLOOK_AUTH_POLL" });
      if (!r || !r.ok) {
        setMsg("outlookOauthMsg", T("failed_with", { err: r && r.error ? r.error : "" }));
        return;
      }
      const result = r.result;
      if (result.status === "success") setMsg("outlookOauthMsg", T("connected"));
      else if (result.status === "expired") setMsg("outlookOauthMsg", T("expired"));
      else setMsg("outlookOauthMsg", T("pending", { err: result.error || "authorization_pending" }));
      await refreshAgentStatus();
    } catch (e) {
      setMsg("outlookOauthMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("outlookOauthMsg", ""), 3500);
  });

  $("outlookImapSave").addEventListener("click", async () => {
    setMsg("outlookImapMsg", T("saving"));
    try {
      const email = $("outlookImapEmail").value.trim();
      const appPassword = $("outlookImapPass").value.trim();
      const r = await bg({
        type: "BG_OUTLOOK_CONFIG",
        payload: { mode: "imap", email, appPassword }
      });
      setMsg("outlookImapMsg", r && r.ok ? T("saved") : T("failed_with", { err: r && r.error ? r.error : "" }));
      if (r && r.ok) {
        setMsg("outlookState", T("imap_configured"));
        await chrome.storage.local.set({ lastOutlookMode: "imap", lastOutlookImapEmail: email });
      }
      await refreshAgentStatus();
    } catch (e) {
      setMsg("outlookImapMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("outlookImapMsg", ""), 2500);
  });

  $("outlookClear").addEventListener("click", async () => {
    setMsg("outlookImapMsg", T("clearing"));
    setMsg("outlookOauthMsg", T("clearing"));
    try {
      const r = await bg({ type: "BG_OUTLOOK_CLEAR" });
      const msg = r && r.ok ? T("cleared") : T("failed_with", { err: r && r.error ? r.error : "" });
      setMsg("outlookImapMsg", msg);
      setMsg("outlookOauthMsg", msg);
      await refreshAgentStatus();
    } catch (e) {
      const msg = T("failed_with", { err: String(e && e.message ? e.message : e) });
      setMsg("outlookImapMsg", msg);
      setMsg("outlookOauthMsg", msg);
    }
    setTimeout(() => {
      setMsg("outlookImapMsg", "");
      setMsg("outlookOauthMsg", "");
    }, 2500);
  });
});
