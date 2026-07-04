const { t, getUiLang, setUiLang, applyStaticI18n } = globalThis.OtpI18n;

let LANG = "en";

// Live countdown state. currentOtp/maxAgeMs feed the per-second tick; the timer
// id lets us cancel a stale loop before starting a fresh one.
let currentOtp = null;
let maxAgeMs = 120_000;
let countdownTimer = null;

// All currently-valid codes (best match first) plus which one is on screen.
// The user can page left/right through them; index 0 is the autofill default.
let otpList = [];
let currentIndex = 0;
const SELECTED_OTP_KEY = "selectedOtpId";

// Human-facing provider label + icon for the source tag.
const PROVIDER_META = {
  qq: { name: "QQ 邮箱", icon: "📩" },
  outlook: { name: "Outlook", icon: "📨" },
  gmail: { name: "Gmail", icon: "📧" }
};

function providerMeta(provider) {
  const key = String(provider || "").toLowerCase();
  return PROVIDER_META[key] || { name: provider ? String(provider) : "", icon: "✉️" };
}

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

// "12s ago · noreply@foo.com" — provider moved to its own source tag.
function formatMeta(otp) {
  if (!otp) return t(LANG, "no_otp_yet");
  const parts = [];
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

async function getMaxAgeMs() {
  try {
    const { maxAgeSec } = await chrome.storage.local.get(["maxAgeSec"]);
    const n = Number(maxAgeSec);
    return (Number.isFinite(n) ? Math.max(10, Math.min(600, n)) : 120) * 1000;
  } catch {
    return 120_000;
  }
}

async function getSelectedOtpId() {
  try {
    const { [SELECTED_OTP_KEY]: selectedOtpId } = await chrome.storage.local.get([SELECTED_OTP_KEY]);
    return typeof selectedOtpId === "string" ? selectedOtpId : "";
  } catch {
    return "";
  }
}

async function setSelectedOtpId(id) {
  try {
    if (id) {
      await chrome.storage.local.set({ [SELECTED_OTP_KEY]: id });
    } else {
      await chrome.storage.local.remove(SELECTED_OTP_KEY);
    }
  } catch {
    // Ignore storage failures; selection still works for the current popup.
  }
}

// Show the provider source tag, or hide it when there is no code.
function renderSource(otp) {
  const tag = $("source");
  if (!tag) return;
  if (!otp || !otp.provider) {
    tag.hidden = true;
    return;
  }
  const m = providerMeta(otp.provider);
  setText("sourceIcon", m.icon);
  setText("sourceName", m.name);
  tag.hidden = false;
}

// Show/hide the paging arrows + "n / m" indicator. Arrows appear only when
// more than one valid code is in the window.
function renderNav() {
  const prev = $("otpPrev");
  const next = $("otpNext");
  const ind = $("otpIndicator");
  const multi = otpList.length > 1;
  if (prev) prev.hidden = !multi;
  if (next) next.hidden = !multi;
  if (ind) {
    ind.hidden = !multi;
    if (multi) ind.textContent = `${currentIndex + 1} / ${otpList.length}`;
  }
}

// Render the currently-selected OTP: code, source, nav, and countdown. Keeps
// currentOtp in sync so the per-second tick targets the on-screen code.
function renderCurrent() {
  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= otpList.length) currentIndex = Math.max(0, otpList.length - 1);
  currentOtp = otpList[currentIndex] || null;

  setText("code", currentOtp && currentOtp.code ? currentOtp.code : "------");
  renderSource(currentOtp);
  renderNav();

  if (currentOtp) {
    startCountdown();
  } else {
    stopCountdown();
    $("otpBar").hidden = true;
    setText("meta", formatMeta(null));
  }
}

// Step to another code by a signed delta, wrapping around the ends so the
// right arrow always advances to the next code.
function goTo(delta) {
  const n = otpList.length;
  if (n <= 1) return;
  currentIndex = (currentIndex + delta + n) % n;
  renderCurrent();
  void setSelectedOtpId(currentOtp && currentOtp.id ? currentOtp.id : "");
}

// Drive the validity bar. The window prefers the TTL parsed from the email
// body (otp.ttlSec); when the email states no validity it falls back to the
// configured maxAgeMs. Hidden entirely when there is no OTP.
function renderCountdown() {
  const bar = $("otpBar");
  const fill = $("otpBarFill");
  if (!bar || !fill) return;

  if (!currentOtp || !currentOtp.receivedAt) {
    bar.hidden = true;
    return;
  }

  // Reason: email-stated TTL is authoritative; maxAgeMs is only a fallback.
  const ttl = Number(currentOtp.ttlSec);
  const windowMs = Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : maxAgeMs;

  const remainMs = currentOtp.receivedAt + windowMs - Date.now();
  const ratio = Math.max(0, Math.min(1, remainMs / windowMs));
  bar.hidden = false;
  fill.style.transform = `scaleX(${ratio})`;

  const expired = remainMs <= 0;
  fill.classList.toggle("expired", expired);
  fill.classList.toggle("warn", !expired && ratio <= 0.2);

  const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
  // Append the validity hint to the meta line without losing the age/from text.
  const base = formatMeta(currentOtp);
  const tail = expired ? t(LANG, "otp_expired") : t(LANG, "expires_in_sec", { n: remainSec });
  setText("meta", base ? `${base} · ${tail}` : tail);

  if (expired) stopCountdown();
}

function startCountdown() {
  stopCountdown();
  renderCountdown();
  if (currentOtp) countdownTimer = setInterval(renderCountdown, 1000);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

async function refresh() {
  setText("meta", t(LANG, "loading"));
  const meta = $("meta");
  if (meta) meta.classList.remove("meta-error");
  maxAgeMs = await getMaxAgeMs();
  const savedSelectedOtpId = await getSelectedOtpId();

  // Agent status first — drives the dot and the multi-tenant login gate.
  let needLogin = false;
  try {
    const r = await bg({ type: "BG_AGENT_STATUS" });
    const ok = !!(r && r.ok);
    setText("agent", t(LANG, ok ? "agent_ok" : "agent_down"));
    setAgentPill(ok);
    // Multi-tenant instance but no valid session → prompt the user to log in.
    if (ok && r.status && r.status.multiTenant && !r.status.authenticated) needLogin = true;
  } catch {
    setText("agent", t(LANG, "agent_down"));
    setAgentPill(false);
  }

  if (needLogin) {
    currentOtp = null;
    otpList = [];
    currentIndex = 0;
    stopCountdown();
    setText("code", "------");
    renderSource(null);
    renderNav();
    $("otpBar").hidden = true;
    setText("meta", t(LANG, "need_login_hint"));
    if (meta) meta.classList.add("meta-error");
    return;
  }

  try {
    const r = await bg({ type: "BG_FETCH_LATEST" });
    const list = r && r.ok && Array.isArray(r.otps) ? r.otps : r && r.ok && r.otp ? [r.otp] : [];
    // Reason: keep the user on the same code across refreshes (e.g. after copy)
    // instead of snapping back to the newest one.
    const prevId = currentOtp && currentOtp.id;
    otpList = list;
    currentIndex = 0;
    const preferredId = savedSelectedOtpId || prevId;
    if (preferredId) {
      const idx = otpList.findIndex((o) => o && o.id === preferredId);
      if (idx >= 0) currentIndex = idx;
    }
    if (otpList.length) {
      renderCurrent();
      void setSelectedOtpId(currentOtp && currentOtp.id ? currentOtp.id : "");
    } else {
      currentOtp = null;
      stopCountdown();
      setText("code", "------");
      renderSource(null);
      renderNav();
      $("otpBar").hidden = true;
      setText("meta", formatMeta(null));
      await setSelectedOtpId("");
    }
  } catch (e) {
    currentOtp = null;
    otpList = [];
    currentIndex = 0;
    stopCountdown();
    setText("code", "------");
    renderSource(null);
    renderNav();
    $("otpBar").hidden = true;
    setText("meta", t(LANG, "agent_unreachable"));
  }
}

// Tint the agent status dot (.pill::before) green/red without depending on text.
function setAgentPill(ok) {
  const el = $("agent");
  if (!el) return;
  el.classList.toggle("ok", ok);
  el.classList.toggle("off", !ok);
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
      // Reason: fill the code the user is actually looking at, not just the
      // newest one — they may have paged to an earlier valid code.
      const code = currentOtp && currentOtp.code ? currentOtp.code : undefined;
      const r = await bg({ type: "BG_FILL_NOW", code });
      // On failure, stop the countdown tick (it would overwrite #meta each second)
      // and tell the user to copy/paste the code manually.
      if (!r || !r.ok) {
        stopCountdown();
        const meta = $("meta");
        if (meta) {
          meta.textContent = t(LANG, "fill_failed_manual");
          meta.classList.add("meta-error");
        }
      }
    } finally {
      $("fill").disabled = false;
    }
  });

  $("copy").addEventListener("click", async () => {
    const code = $("code").textContent || "";
    const cleaned = code.trim().replace(/[\s-]+/g, "");
    if (!/^[A-Za-z0-9]{4,10}$/.test(cleaned)) return;
    await navigator.clipboard.writeText(cleaned);
    setText("meta", t(LANG, "copied"));
    setTimeout(refresh, 700);
  });

  // Click the code itself to copy — reuses the same handler as the Copy button.
  $("code").addEventListener("click", () => $("copy").click());

  // Page between multiple valid codes (arrows + ←/→ keys).
  $("otpPrev").addEventListener("click", () => goTo(-1));
  $("otpNext").addEventListener("click", () => goTo(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goTo(1);
    }
  });

  $("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  refresh();
});
