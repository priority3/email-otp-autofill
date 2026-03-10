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
  setMsg("agentStatus", ok ? `OK · ${detail || ""}` : `DOWN · ${detail || ""}`);
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
  const raw = await chrome.storage.local.get(["agentBaseUrl", "maxAgeSec"]);
  $("agentBaseUrl").value = raw.agentBaseUrl || "http://127.0.0.1:17373";
  $("maxAgeSec").value = String(Number.isFinite(raw.maxAgeSec) ? raw.maxAgeSec : 120);
}

async function saveExtSettings() {
  const agentBaseUrl = $("agentBaseUrl").value.trim() || "http://127.0.0.1:17373";
  const maxAgeSec = Math.max(10, Math.min(600, Number($("maxAgeSec").value || "120")));
  await chrome.storage.local.set({ agentBaseUrl, maxAgeSec });
  setMsg("saveExtMsg", "Saved.");
  setTimeout(() => setMsg("saveExtMsg", ""), 1200);
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
      setAgentStatus(false, r && r.error ? r.error : "");
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
      setMsg("qqState", cfg.qq.configured ? "Configured" : "Not configured");
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
        setMsg("outlookState", cfg.outlook.oauthConnected ? "OAuth connected" : "OAuth not connected");
      } else {
        setMsg("outlookState", cfg.outlook.imapConfigured ? "IMAP configured" : "IMAP not configured");
      }
    }

    await chrome.storage.local.set(cache);
  } catch (e) {
    setAgentStatus(false, String(e && e.message ? e.message : e));
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadExtSettings();
  await loadLastConfig();
  renderOutlookMode($("outlookMode").value);
  await refreshAgentStatus();

  $("refreshStatus").addEventListener("click", refreshAgentStatus);
  $("saveExt").addEventListener("click", saveExtSettings);

  $("qqSave").addEventListener("click", async () => {
    setMsg("qqMsg", "Saving…");
    try {
      const email = $("qqEmail").value.trim();
      const authCode = $("qqAuthCode").value.trim();
      const r = await bg({ type: "BG_QQ_CONFIG", email, authCode });
      setMsg("qqMsg", r && r.ok ? "Saved." : `Failed: ${r && r.error ? r.error : ""}`);
      if (r && r.ok) await chrome.storage.local.set({ lastQqEmail: email });
      $("qqAuthCode").value = "";
      await refreshAgentStatus();
    } catch (e) {
      setMsg("qqMsg", `Failed: ${String(e && e.message ? e.message : e)}`);
    }
    setTimeout(() => setMsg("qqMsg", ""), 2500);
  });

  $("qqClear").addEventListener("click", async () => {
    setMsg("qqMsg", "Clearing…");
    try {
      const r = await bg({ type: "BG_QQ_CLEAR" });
      setMsg("qqMsg", r && r.ok ? "Cleared." : "Failed.");
      await refreshAgentStatus();
    } catch (e) {
      setMsg("qqMsg", `Failed: ${String(e && e.message ? e.message : e)}`);
    }
    setTimeout(() => setMsg("qqMsg", ""), 2500);
  });

  $("outlookMode").addEventListener("change", () => {
    renderOutlookMode($("outlookMode").value);
  });

  $("outlookOauthSave").addEventListener("click", async () => {
    setMsg("outlookOauthMsg", "Saving…");
    try {
      const clientId = $("outlookClientId").value.trim();
      const r = await bg({ type: "BG_OUTLOOK_CONFIG", payload: { mode: "oauth", clientId } });
      setMsg("outlookOauthMsg", r && r.ok ? "Saved." : `Failed: ${r && r.error ? r.error : ""}`);
      if (r && r.ok) await chrome.storage.local.set({ lastOutlookMode: "oauth", lastOutlookClientId: clientId });
      await refreshAgentStatus();
    } catch (e) {
      setMsg("outlookOauthMsg", `Failed: ${String(e && e.message ? e.message : e)}`);
    }
    setTimeout(() => setMsg("outlookOauthMsg", ""), 2500);
  });

  $("outlookAuthStart").addEventListener("click", async () => {
    setMsg("deviceCodeMsg", "Starting…");
    try {
      const r = await bg({ type: "BG_OUTLOOK_AUTH_START" });
      if (!r || !r.ok) {
        setMsg("deviceCodeMsg", `Failed: ${r && r.error ? r.error : ""}`);
        return;
      }
      const dc = r.deviceCode;
      const link = dc.verification_uri_complete || dc.verification_uri;
      setMsg(
        "deviceCodeMsg",
        `Open ${dc.verification_uri} and enter code ${dc.user_code} (expires in ${dc.expires_in}s).`
      );
      if (link) chrome.tabs.create({ url: link });
    } catch (e) {
      setMsg("deviceCodeMsg", `Failed: ${String(e && e.message ? e.message : e)}`);
    }
  });

  $("outlookAuthPoll").addEventListener("click", async () => {
    setMsg("outlookOauthMsg", "Polling…");
    try {
      const r = await bg({ type: "BG_OUTLOOK_AUTH_POLL" });
      if (!r || !r.ok) {
        setMsg("outlookOauthMsg", `Failed: ${r && r.error ? r.error : ""}`);
        return;
      }
      const result = r.result;
      if (result.status === "success") setMsg("outlookOauthMsg", "Connected.");
      else if (result.status === "expired") setMsg("outlookOauthMsg", "Expired. Start again.");
      else setMsg("outlookOauthMsg", `Pending (${result.error || "authorization_pending"})`);
      await refreshAgentStatus();
    } catch (e) {
      setMsg("outlookOauthMsg", `Failed: ${String(e && e.message ? e.message : e)}`);
    }
    setTimeout(() => setMsg("outlookOauthMsg", ""), 3500);
  });

  $("outlookImapSave").addEventListener("click", async () => {
    setMsg("outlookImapMsg", "Saving…");
    try {
      const email = $("outlookImapEmail").value.trim();
      const appPassword = $("outlookImapPass").value.trim();
      const r = await bg({
        type: "BG_OUTLOOK_CONFIG",
        payload: { mode: "imap", email, appPassword }
      });
      setMsg("outlookImapMsg", r && r.ok ? "Saved." : `Failed: ${r && r.error ? r.error : ""}`);
      if (r && r.ok) await chrome.storage.local.set({ lastOutlookMode: "imap", lastOutlookImapEmail: email });
      $("outlookImapPass").value = "";
      await refreshAgentStatus();
    } catch (e) {
      setMsg("outlookImapMsg", `Failed: ${String(e && e.message ? e.message : e)}`);
    }
    setTimeout(() => setMsg("outlookImapMsg", ""), 2500);
  });

  $("outlookClear").addEventListener("click", async () => {
    setMsg("outlookImapMsg", "Clearing…");
    setMsg("outlookOauthMsg", "Clearing…");
    try {
      const r = await bg({ type: "BG_OUTLOOK_CLEAR" });
      const msg = r && r.ok ? "Cleared." : `Failed: ${r && r.error ? r.error : ""}`;
      setMsg("outlookImapMsg", msg);
      setMsg("outlookOauthMsg", msg);
      await refreshAgentStatus();
    } catch (e) {
      const msg = `Failed: ${String(e && e.message ? e.message : e)}`;
      setMsg("outlookImapMsg", msg);
      setMsg("outlookOauthMsg", msg);
    }
    setTimeout(() => {
      setMsg("outlookImapMsg", "");
      setMsg("outlookOauthMsg", "");
    }, 2500);
  });
});
