function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function formatMeta(otp) {
  if (!otp) return "No OTP yet.";
  const parts = [];
  if (otp.provider) parts.push(String(otp.provider));
  if (otp.receivedAt) {
    const ageSec = Math.max(0, Math.floor((Date.now() - otp.receivedAt) / 1000));
    parts.push(`${ageSec}s ago`);
  }
  if (otp.from) parts.push(otp.from);
  return parts.join(" · ");
}

async function bg(message) {
  return await chrome.runtime.sendMessage(message);
}

async function refresh() {
  setText("meta", "Loading…");
  try {
    const r = await bg({ type: "BG_FETCH_LATEST" });
    const otp = r && r.ok ? r.otp : null;
    setText("code", otp && otp.code ? otp.code : "------");
    setText("meta", formatMeta(otp));
  } catch (e) {
    setText("code", "------");
    setText("meta", "Agent not reachable.");
  }

  try {
    const r = await bg({ type: "BG_AGENT_STATUS" });
    if (r && r.ok) setText("agent", "Agent: OK");
    else setText("agent", "Agent: DOWN");
  } catch {
    setText("agent", "Agent: DOWN");
  }
}

document.addEventListener("DOMContentLoaded", () => {
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
    setText("meta", "Copied.");
    setTimeout(refresh, 700);
  });

  $("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  refresh();
});

