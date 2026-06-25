const { t, getUiLang, setUiLang, applyStaticI18n } = globalThis.OtpI18n;

let LANG = "en";
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

// ---- account model -------------------------------------------------------
// A flat list of mailbox accounts built from /v1/status. Each entry:
//   { type: "qq" | "outlook_oauth", email?, configured }
let accounts = [];
// What the right panel is currently showing.
let selected = null; // "agent" | "add" | {type,email} | null
let oauthPollTimer = null;
let oauthPollDelayMs = 5000;
let oauthPollExpiresAt = 0;
let oauthPollInFlight = false;
let oauthPollRunId = 0;

// ---- password eye toggle (unchanged behavior) ----------------------------
const EYE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function setPwdVisible(input, btn, visible) {
  input.type = visible ? "text" : "password";
  btn.innerHTML = visible ? EYE_OFF_ICON : EYE_ICON;
  btn.setAttribute("aria-label", T(visible ? "hide_password" : "show_password"));
}

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

function refreshPwdToggleLabels() {
  document.querySelectorAll(".pwd-toggle").forEach((btn) => {
    const input = $(btn.getAttribute("data-toggle"));
    if (!input) return;
    btn.setAttribute("aria-label", T(input.type === "text" ? "hide_password" : "show_password"));
  });
}

// ---- i18n ----------------------------------------------------------------
function applyRichI18n() {
  const map = { qqHowto: "qq_howto" };
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
  // Re-apply dynamic auth labels (login/register) after static i18n overwrites.
  setAuthMode(authMode);
  renderAccountList();
}

// ---- panel switching -----------------------------------------------------
const PANELS = ["panelEmpty", "panelAgent", "panelAccount"];

function showPanel(id) {
  for (const p of PANELS) {
    const el = $(p);
    if (el) el.hidden = p !== id;
  }
}

function setNavActive(key) {
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  if (key === "agent") $("navAgent").classList.add("active");
  else if (key === "add") $("navAdd").classList.add("active");
  else if (key && key.email) {
    const node = document.querySelector(`.nav-item[data-email="${cssEscape(key.email)}"]`);
    if (node) node.classList.add("active");
  }
}

// Minimal attribute-selector escape for emails (no CSS.escape in older engines).
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// ---- account list (sidebar) ----------------------------------------------
const TYPE_ICON = { qq: "📩", outlook_oauth: "🔑" };

function renderAccountList() {
  const list = $("accountList");
  if (!list) return;
  list.innerHTML = "";

  for (const acc of accounts) {
    const labelText = acc.email || (acc.type === "outlook_oauth" ? "Outlook OAuth" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item account-item";
    btn.setAttribute("data-email", labelText);
    btn.setAttribute("data-type", acc.type);

    const ic = document.createElement("span");
    ic.className = "nav-ic";
    ic.textContent = TYPE_ICON[acc.type] || "✉️";

    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = labelText;
    label.title = labelText;

    const dot = document.createElement("span");
    dot.className = "nav-dot" + (acc.configured ? " ok" : "");

    btn.append(ic, label, dot);
    btn.addEventListener("click", () => selectAccount(acc));
    list.appendChild(btn);
  }

  const empty = $("accountsEmpty");
  if (empty) empty.hidden = accounts.length > 0;

  // Keep the active highlight in sync after a re-render.
  if (selected && selected.email) setNavActive(selected);
}

// ---- selection handlers --------------------------------------------------
function selectAgent() {
  selected = "agent";
  setNavActive("agent");
  showPanel("panelAgent");
}

function selectAdd() {
  selected = "add";
  setNavActive("add");
  $("acctTitle").querySelector("span:last-child").textContent = T("add_account_title");
  $("acctType").disabled = false;
  $("acctType").value = "qq";
  $("acctEmail").value = "";
  $("acctEmail").disabled = false;
  $("acctSecret").value = "";
  $("acctRemove").hidden = true;
  setMsg("acctMsg", "");
  renderAccountFormByType("qq");
  showPanel("panelAccount");
}

function selectAccount(acc) {
  selected = { type: acc.type, email: acc.email };
  setNavActive(selected);
  $("acctType").value = acc.type;
  $("acctType").disabled = true; // type is fixed once created

  if (acc.type === "outlook_oauth") {
    // Outlook OAuth: show the OAuth panel with connect/clear actions
    $("acctTitle").querySelector("span:last-child").textContent = acc.email || "Outlook OAuth";
    renderAccountFormByType("outlook_oauth");
    showPanel("panelAccount");
  } else {
    // QQ account: show the edit form
    $("acctTitle").querySelector("span:last-child").textContent = acc.email;
    $("acctEmail").value = acc.email;
    $("acctEmail").disabled = true; // email is the key; change = add new
    $("acctSecret").value = "";
    $("acctRemove").hidden = false;
    setMsg("acctMsg", "");
    renderAccountFormByType("qq");
    showPanel("panelAccount");
    // Pre-fill the stored secret (masked as dots, revealable via the eye).
    revealAccountSecret(acc);
  }
}

function setText(id, text) {
  const el = $(id);
  if (el && text != null) el.textContent = text;
}

// Toggle form fields for QQ vs Outlook OAuth.
async function renderAccountFormByType(type) {
  const isQq = type === "qq";
  $("qqFields").hidden = !isQq;
  $("outlookOauthFields").hidden = isQq;
  $("acctActions").hidden = !isQq; // OAuth has its own buttons
  if (!isQq) {
    // Switch user to OAuth mode on the server, then refresh state.
    try { await bg({ type: "BG_OUTLOOK_CONFIG", payload: { mode: "oauth" } }); } catch { /* ignore */ }
    await refreshOutlookOAuthState();
  }
}

async function refreshOutlookOAuthState() {
  try {
    const r = await bg({ type: "BG_AGENT_STATUS" });
    if (r && r.ok && r.status && r.status.config) {
      const ol = r.status.config.outlook || {};
      const connected = !!ol.oauthConnected;
      console.log("[OAuth] refreshOutlookOAuthState:", { connected, clientIdSet: ol.clientIdSet, mode: ol.mode });
      setMsg("outlookState", T(connected ? "oauth_connected" : (ol.clientIdSet ? "oauth_not_connected" : "oauth_no_client_id")));
      // Toggle action groups: Start/Clear when disconnected, Disconnect when connected.
      const disGroup = $("outlookDisconnectedActions");
      const conGroup = $("outlookConnectedActions");
      console.log("[OAuth] Elements:", { disGroup: !!disGroup, conGroup: !!conGroup });
      if (disGroup) disGroup.hidden = connected;
      if (conGroup) conGroup.hidden = !connected;
    }
  } catch {
    // ignore
  }
}

async function revealAccountSecret(acc) {
  if (acc.type !== "qq") return; // Only QQ has a revealable secret
  try {
    const r = await bg({ type: "BG_REVEAL_SECRET", kind: "qq", email: acc.email });
    if (r && r.ok && r.value) $("acctSecret").value = r.value;
  } catch {
    // agent down or no secret — leave empty
  }
}

// ---- agent settings (unchanged logic) ------------------------------------
function setAgentStatus(ok, detail) {
  setMsg("agentStatus", T(ok ? "agent_ok_detail" : "agent_down_detail", { detail: detail || "" }));
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

const DEFAULT_BASE_URL = "https://otp.razet.me";
// Origins already declared in manifest host_permissions (no runtime request needed).
const PRE_GRANTED_ORIGINS = new Set(["https://otp.razet.me/*", "http://127.0.0.1:17373/*"]);

async function loadExtSettings() {
  const raw = await chrome.storage.local.get(["agentBaseUrl", "maxAgeSec"]);
  // Connection field lives in the login panel (editable only before login).
  $("loginBaseUrl").value = raw.agentBaseUrl || DEFAULT_BASE_URL;
  $("maxAgeSec").value = String(Number.isFinite(raw.maxAgeSec) ? raw.maxAgeSec : 120);
}

// panelAgent save: only the post-login setting (max OTP age). The server
// address is fixed once logged in — change it from the login panel after logout.
async function saveExtSettings() {
  setMsg("saveExtMsg", T("saving"));
  const maxAgeSec = Math.max(10, Math.min(600, Number($("maxAgeSec").value || "120")));
  try {
    await chrome.storage.local.set({ maxAgeSec });
    setMsg("saveExtMsg", T("saved"));
  } catch (e) {
    setMsg("saveExtMsg", T("save_failed_with", { err: String(e && e.message ? e.message : e) }));
    return;
  }
  setTimeout(() => setMsg("saveExtMsg", ""), 2500);
}

// Login-panel connection save: persists server URL + optional API key, requests
// host permission for custom domains, then reconnects (re-checks status).
async function saveConnection() {
  setMsg("loginConnMsg", T("saving"));
  const agentBaseUrl = $("loginBaseUrl").value.trim() || DEFAULT_BASE_URL;

  const origin = originPatternFromBaseUrl(agentBaseUrl);
  let permGranted = true;
  if (origin && !PRE_GRANTED_ORIGINS.has(origin)) {
    try {
      // permissions.request must run in a user gesture — keep before awaits.
      permGranted = await chrome.permissions.request({ origins: [origin] });
    } catch {
      permGranted = false;
    }
  }

  try {
    // Drop any legacy API key — public instances authenticate by login only.
    await chrome.storage.local.set({ agentBaseUrl });
    await chrome.storage.local.remove("agentApiKey");
  } catch (e) {
    setMsg("loginConnMsg", T("save_failed_with", { err: String(e && e.message ? e.message : e) }));
    return;
  }

  if (origin && !PRE_GRANTED_ORIGINS.has(origin) && !permGranted) {
    setMsg("loginConnMsg", T("perm_not_granted", { origin }));
  } else {
    setMsg("loginConnMsg", T("connected_ok"));
  }
  setTimeout(() => setMsg("loginConnMsg", ""), 2500);
  await refreshStatus();
}

// ---- multi-tenant auth gating --------------------------------------------
let authMode = "login"; // "login" | "register"
let bootSelected = false; // whether the default detail panel was chosen once
let requireInvite = false; // whether this instance requires an invite to register

// Toggle the login panel vs the settings UI based on the agent status payload.
// Returns true if the settings UI should be shown (single-tenant, or logged in).
function applyAuthState(status) {
  const multiTenant = !!(status && status.multiTenant);
  const authed = !multiTenant || (status && status.authenticated);

  const layout = document.querySelector(".settings-layout");
  $("loginPanel").hidden = authed;
  $("authBar").hidden = !(multiTenant && authed);
  if (layout) layout.hidden = !authed;

  // Remember whether this instance requires an invite (only present on the
  // unauthenticated status payload) and refresh the invite field visibility.
  if (!authed) {
    requireInvite = !!(status && status.requireInvite);
    setAuthMode(authMode);
  }
  return authed;
}

// Force the login panel up (used when the server is unreachable so the user can
// still edit the server address). Opens the connection section automatically.
function showLoginPanel() {
  const layout = document.querySelector(".settings-layout");
  if (layout) layout.hidden = true;
  $("authBar").hidden = true;
  $("loginPanel").hidden = false;
  const conn = $("connDetails");
  if (conn) conn.open = true;
}

async function loadMe() {
  try {
    const r = await bg({ type: "BG_AUTH_ME" });
    if (r && r.ok && r.user) setMsg("authWho", T("logged_in_as", { name: r.user.username }));
  } catch {
    // ignore
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === "login";
  $("loginTitle").textContent = T(isLogin ? "login" : "register");
  $("authSubmit").textContent = T(isLogin ? "login" : "register");
  $("authToggle").textContent = T(isLogin ? "switch_to_register" : "switch_to_login");
  // Invite code only matters when registering on an instance that requires it.
  const row = $("authInviteRow");
  if (row) row.hidden = !(mode === "register" && requireInvite);
  setMsg("authMsg", "");
}

// Clear previous validation state on the auth inputs.
function clearAuthErrors() {
  for (const id of ["authUser", "authPass", "authInvite"]) {
    const el = $(id);
    if (el) el.classList.remove("input-error");
  }
  const msg = $("authMsg");
  if (msg) msg.classList.remove("msg-error");
}

// Flag one field as invalid: red border, focus it, show the message in red.
function authError(inputId, key) {
  const el = $(inputId);
  if (el) {
    el.classList.add("input-error");
    el.focus();
  }
  const msg = $("authMsg");
  if (msg) msg.classList.add("msg-error");
  setMsg("authMsg", T(key));
}

async function submitAuth() {
  clearAuthErrors();
  const username = $("authUser").value.trim();
  const password = $("authPass").value;
  const isReg = authMode === "register";

  // Client-side validation with clear, field-specific messages (mirrors the
  // backend rules: username >= 3, password >= 8).
  if (!username) return authError("authUser", "err_username_required");
  if (isReg && username.length < 3) return authError("authUser", "err_username_short");
  if (!password) return authError("authPass", "err_password_required");
  if (isReg && password.length < 8) return authError("authPass", "err_password_short");
  if (isReg && requireInvite && !$("authInvite").value.trim())
    return authError("authInvite", "err_invite_required");

  setMsg("authMsg", T("saving"));
  try {
    const type = authMode === "register" ? "BG_AUTH_REGISTER" : "BG_AUTH_LOGIN";
    const msg = { type, username, password };
    if (authMode === "register") msg.inviteCode = $("authInvite").value.trim();
    const r = await bg(msg);
    if (r && r.ok) {
      $("authPass").value = "";
      $("authInvite").value = "";
      await refreshStatus();
    } else {
      const err = (r && r.error) || "";
      const m = $("authMsg");
      if (m) m.classList.add("msg-error");
      // Friendlier, field-aware messages for the common rejections.
      if (err === "invalid_invite") {
        $("authInvite") && $("authInvite").classList.add("input-error");
        setMsg("authMsg", T("invalid_invite"));
      } else if (err === "username_taken") {
        $("authUser") && $("authUser").classList.add("input-error");
        setMsg("authMsg", T("auth_failed", { err }));
      } else {
        setMsg("authMsg", T("auth_failed", { err }));
      }
    }
  } catch (e) {
    setMsg("authMsg", T("auth_failed", { err: String(e && e.message ? e.message : e) }));
  }
}

async function doLogout() {
  await bg({ type: "BG_AUTH_LOGOUT" });
  await refreshStatus();
}

// ---- status → account list -----------------------------------------------
async function refreshStatus() {
  try {
    const r = await bg({ type: "BG_AGENT_STATUS" });
    if (!r || !r.ok) {
      const err = r && r.error ? String(r.error) : "";
      if (err === "unauthorized") setAgentStatus(false, T("need_api_key"));
      else if (err) setAgentStatus(false, err);
      else setAgentStatus(false, "");
      accounts = [];
      renderAccountList();
      // Can't reach / talk to the server → surface the login panel so the user
      // can fix the server address (and log in).
      showLoginPanel();
      return;
    }

    // Multi-tenant gating: show login panel when not authenticated.
    const authed = applyAuthState(r.status);
    if (!authed) return; // login panel is up; nothing else to render
    if (r.status.multiTenant) loadMe();

    // Pick a default panel once, only after we know the user is authed — avoids
    // flashing the settings UI before the auth state is known.
    if (!bootSelected) {
      bootSelected = true;
      selectAgent();
    }

    setAgentStatus(true, `${r.status.agent.host}:${r.status.agent.port}`);
    const cfg = r.status.config || {};

    // Build the flat account list from qq accounts + outlook oauth.
    const next = [];
    const qq = (cfg.qq && cfg.qq.accounts) || [];
    for (const a of qq) next.push({ type: "qq", email: a.email, configured: !!a.configured });
    // Outlook OAuth is a single account (no email in list, just the type).
    const ol = cfg.outlook || {};
    if (ol.oauthConnected) {
      next.push({ type: "outlook_oauth", email: ol.oauthEmail || "Outlook OAuth", configured: !!ol.oauthConnected });
    }
    accounts = next;
    renderAccountList();

    // Sync Outlook OAuth action buttons with connection state.
    const outlookConnected = !!ol.oauthConnected;
    const disGroup = $("outlookDisconnectedActions");
    const conGroup = $("outlookConnectedActions");
    console.log("[OAuth] refreshStatus:", { outlookConnected, disGroup: !!disGroup, conGroup: !!conGroup });
    if (disGroup) disGroup.hidden = outlookConnected;
    if (conGroup) conGroup.hidden = !outlookConnected;
  } catch (e) {
    setAgentStatus(false, String(e && e.message ? e.message : e));
    accounts = [];
    renderAccountList();
  }
}

// ---- save / remove account -----------------------------------------------
async function saveAccount() {
  const type = $("acctType").value;
  if (type === "outlook_oauth") return; // OAuth has its own save button

  const email = $("acctEmail").value.trim();
  const secret = $("acctSecret").value.trim();
  if (!email || !secret) {
    setMsg("acctMsg", T("failed"));
    return;
  }
  // Saving now verifies the mailbox server-side (real IMAP login), which takes
  // a few seconds — show "verifying" and block double-clicks.
  setMsg("acctMsg", T("verifying"));
  $("acctSave").disabled = true;
  try {
    const r = await bg({ type: "BG_QQ_CONFIG", email, authCode: secret });
    if (r && r.ok) {
      setMsg("acctMsg", T("saved"));
      await refreshStatus();
      // Re-select the (now saved) account so the panel shows edit mode.
      selectAccount({ type, email, configured: true });
    } else {
      setMsg("acctMsg", verifyErrorText(r && r.error));
    }
  } catch (e) {
    setMsg("acctMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
  } finally {
    $("acctSave").disabled = false;
  }
  setTimeout(() => setMsg("acctMsg", ""), 3500);
}

// Map a backend verification error code to a friendly message.
function verifyErrorText(err) {
  if (err === "auth_failed") return T("verify_failed_auth");
  if (err === "connect_timeout" || err === "network_error") return T("verify_failed_conn");
  return T("failed_with", { err: err || "" });
}

async function removeAccount() {
  if (!selected || !selected.email) return;
  const { type, email } = selected;
  if (type !== "qq") return; // Only QQ accounts can be removed this way

  setMsg("acctMsg", T("removing"));
  try {
    const r = await bg({ type: "BG_QQ_REMOVE", email });
    if (r && r.ok) {
      setMsg("acctMsg", T("cleared"));
      await refreshStatus();
      selected = null;
      showPanel("panelEmpty");
      setNavActive(null);
    } else {
      setMsg("acctMsg", T("failed"));
    }
  } catch (e) {
    setMsg("acctMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
  }
}

// ---- Outlook OAuth (now integrated in account panel) ---------------------
function stopOauthAutoPoll() {
  oauthPollRunId++;
  if (oauthPollTimer) clearTimeout(oauthPollTimer);
  oauthPollTimer = null;
  oauthPollInFlight = false;
  oauthPollExpiresAt = 0;
  const start = $("outlookAuthStart");
  if (start) start.disabled = false;
}

function scheduleOauthAutoPoll(runId, delayMs = oauthPollDelayMs) {
  if (oauthPollTimer) clearTimeout(oauthPollTimer);
  oauthPollTimer = setTimeout(() => void pollOutlookAuthOnce(runId), Math.max(1000, delayMs));
}

async function pollOutlookAuthOnce(runId) {
  if (runId !== oauthPollRunId) return;
  if (oauthPollInFlight) return;
  if (oauthPollExpiresAt && Date.now() >= oauthPollExpiresAt) {
    stopOauthAutoPoll();
    setMsg("outlookOauthMsg", T("expired"));
    await refreshStatus();
    return;
  }

  oauthPollInFlight = true;
  try {
    const r = await bg({ type: "BG_OUTLOOK_AUTH_POLL" });
    if (runId !== oauthPollRunId) return;
    if (!r || !r.ok) {
      stopOauthAutoPoll();
      setMsg("outlookOauthMsg", T("failed_with", { err: r && r.error ? r.error : "" }));
      return;
    }

    const result = r.result;
    if (result.status === "success") {
      stopOauthAutoPoll();
      setMsg("outlookOauthMsg", T("connected"));
      // Toggle buttons immediately before waiting for status refresh.
      const disEl = $("outlookDisconnectedActions");
      const conEl = $("outlookConnectedActions");
      console.log("[OAuth] Poll success, toggling:", { disEl: !!disEl, conEl: !!conEl });
      if (disEl) disEl.hidden = true;
      if (conEl) conEl.hidden = false;
      await refreshStatus();
      await refreshOutlookOAuthState();
      setTimeout(() => setMsg("outlookOauthMsg", ""), 2500);
      return;
    }
    if (result.status === "expired") {
      stopOauthAutoPoll();
      setMsg("outlookOauthMsg", T("expired"));
      await refreshStatus();
      return;
    }

    if (result.error === "slow_down") oauthPollDelayMs += 5000;
    setMsg("outlookOauthMsg", T("oauth_waiting", { sec: Math.round(oauthPollDelayMs / 1000) }));
    scheduleOauthAutoPoll(runId);
  } catch (e) {
    if (runId !== oauthPollRunId) return;
    stopOauthAutoPoll();
    setMsg("outlookOauthMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
  } finally {
    if (runId === oauthPollRunId) oauthPollInFlight = false;
  }
}

function wireOauth() {
  $("outlookAuthStart").addEventListener("click", async () => {
    stopOauthAutoPoll();
    const runId = ++oauthPollRunId;
    setMsg("deviceCodeMsg", T("starting"));
    setMsg("outlookOauthMsg", "");
    $("outlookAuthStart").disabled = true;
    try {
      const r = await bg({ type: "BG_OUTLOOK_AUTH_START" });
      if (runId !== oauthPollRunId) return;
      if (!r || !r.ok) {
        stopOauthAutoPoll();
        setMsg("deviceCodeMsg", T("failed_with", { err: r && r.error ? r.error : "" }));
        return;
      }
      const dc = r.deviceCode;
      const link = dc.verification_uri_complete || dc.verification_uri;
      // Store the device code so the content script can auto-fill it on the
      // Microsoft login page (the page may redirect and lose the URL param).
      if (dc.user_code) {
        chrome.storage.local.set({
          msDeviceCode: dc.user_code,
          msDeviceCodeExp: Date.now() + Math.max(1, Number(dc.expires_in) || 900) * 1000
        });
      }
      oauthPollDelayMs = Math.max(1, Number(dc.interval) || 5) * 1000;
      oauthPollExpiresAt = Date.now() + Math.max(1, Number(dc.expires_in) || 900) * 1000;
      setMsg("deviceCodeMsg", T("device_code_msg", { uri: dc.verification_uri, code: dc.user_code, sec: dc.expires_in }));
      setMsg("outlookOauthMsg", T("oauth_waiting", { sec: Math.round(oauthPollDelayMs / 1000) }));
      if (link) {
        // Reason: Open in a popup window so the options page stays visible
        // and the user can see the live polling status while signing in.
        chrome.windows.create({ url: link, type: "popup", width: 500, height: 700 });
      }
      scheduleOauthAutoPoll(runId, oauthPollDelayMs);
    } catch (e) {
      if (runId !== oauthPollRunId) return;
      stopOauthAutoPoll();
      setMsg("outlookOauthMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
  });

  $("outlookClear").addEventListener("click", async () => {
    stopOauthAutoPoll();
    setMsg("outlookOauthMsg", T("clearing"));
    try {
      const r = await bg({ type: "BG_OUTLOOK_CLEAR" });
      setMsg("outlookOauthMsg", r && r.ok ? T("cleared") : T("failed"));
      await refreshStatus();
      if (r && r.ok) {
        selected = null;
        setNavActive(null);
        showPanel("panelEmpty");
      }
    } catch (e) {
      setMsg("outlookOauthMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("outlookOauthMsg", ""), 2500);
  });

  $("outlookDisconnect").addEventListener("click", async () => {
    stopOauthAutoPoll();
    setMsg("outlookOauthMsg", T("clearing"));
    try {
      const r = await bg({ type: "BG_OUTLOOK_CLEAR" });
      setMsg("outlookOauthMsg", r && r.ok ? T("cleared") : T("failed"));
      await refreshStatus();
      await refreshOutlookOAuthState();
    } catch (e) {
      setMsg("outlookOauthMsg", T("failed_with", { err: String(e && e.message ? e.message : e) }));
    }
    setTimeout(() => setMsg("outlookOauthMsg", ""), 2500);
  });
}

// ---- boot ----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  LANG = await getUiLang();
  applyLang(LANG);

  await loadExtSettings();
  await refreshStatus();

  $("uiLang").addEventListener("change", async () => {
    const lang = $("uiLang").value;
    await setUiLang(lang);
    applyLang(lang);
    await refreshStatus();
  });

  $("navAgent").addEventListener("click", selectAgent);
  $("navAdd").addEventListener("click", selectAdd);
  $("refreshStatus").addEventListener("click", refreshStatus);
  $("saveExt").addEventListener("click", saveExtSettings);
  $("acctType").addEventListener("change", () => renderAccountFormByType($("acctType").value));
  $("acctSave").addEventListener("click", saveAccount);
  $("acctRemove").addEventListener("click", removeAccount);

  // multi-tenant auth controls
  setAuthMode("login");
  $("authSubmit").addEventListener("click", submitAuth);
  $("authPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });
  $("authToggle").addEventListener("click", (e) => {
    e.preventDefault();
    clearAuthErrors();
    setAuthMode(authMode === "login" ? "register" : "login");
  });
  $("logoutBtn").addEventListener("click", doLogout);
  $("loginSaveConn").addEventListener("click", saveConnection);
  // Clear a field's error state as soon as the user edits it.
  for (const id of ["authUser", "authPass", "authInvite"]) {
    $(id).addEventListener("input", () => {
      $(id).classList.remove("input-error");
    });
  }

  wireOauth();
  initPwdToggles();

  // Note: the default detail panel is selected inside refreshStatus() only after
  // auth is confirmed, to avoid flashing the settings UI before login.
});
