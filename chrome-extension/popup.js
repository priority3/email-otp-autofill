const { t, getUiLang, setUiLang, applyStaticI18n } = globalThis.OtpI18n;

let LANG = "en";

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function formatMeta(otp) {
  if (!otp) return t(LANG, "no_otp_yet");
  const parts = [];
  if (otp.provider) parts.push(String(otp.provider));
  if (otp.receivedAt) {
    const ageSec = Math.max(0, Math.floor((Date.now() - otp.receivedAt) / 1000));
    parts.push(t(LANG, "n_sec_ago", { n: ageSec }));
  }
  if (otp.from) parts.push(otp.from);
  return parts.join(" · ");
}

async function bg(message) {
  return await chrome.runtime.sendMessage(message);
}

async function refresh() {
  setText("meta", t(LANG, "loading"));
  try {
    const r = await bg({ type: "BG_FETCH_LATEST" });
    const otp = r && r.ok ? r.otp : null;
    setText("code", otp && otp.code ? otp.code : "------");
    setText("meta", formatMeta(otp));
  } catch (e) {
    setText("code", "------");
    setText("meta", t(LANG, "agent_unreachable"));
  }

  try {
    const r = await bg({ type: "BG_AGENT_STATUS" });
    if (r && r.ok) setText("agent", t(LANG, "agent_ok"));
    else setText("agent", t(LANG, "agent_down"));
  } catch {
    setText("agent", t(LANG, "agent_down"));
  }
}

function applyLang(lang) {
  LANG = lang;
  applyStaticI18n(document, LANG);
  const sel = $("uiLang");
  if (sel) sel.value = LANG;
}

document.addEventListener("DOMContentLoaded", async () => {
  LANG = await getUiLang();
  applyLang(LANG);

  $("uiLang").addEventListener("change", async () => {
    const lang = $("uiLang").value;
    await setUiLang(lang);
    applyLang(lang);
    // Reason: re-render dynamic strings (code meta + agent status) immediately.
    await refresh();
  });

  $("fill").addEventListener("click", async () => {
    $("fill").disabled = true;
    try {
      await bg({ type: "BG_FILL_NOW" });
    } finally {
      $("fill").disabled = false;
    }
  });

  $("copy").addEventListener("click", async () => {
    const code = $("code").textContent || "";
    const cleaned = code.replace(/\D/g, "");
    if (cleaned.length < 4) return;
    await navigator.clipboard.writeText(cleaned);
    setText("meta", t(LANG, "copied"));
    setTimeout(refresh, 700);
  });

  $("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  refresh();
});
