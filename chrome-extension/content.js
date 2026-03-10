function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0;
}

function isTextLikeInput(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  const t = (el.getAttribute("type") || "text").toLowerCase();
  return ["text", "tel", "number", "search", "email", "url", "password"].includes(t);
}

function likelyOtp(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac === "one-time-code" || ac === "otp") return true;
  const n = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
  if (/(otp|one.?time|code|verify|verification|pin)/.test(n)) return true;
  if (el.maxLength >= 4 && el.maxLength <= 8) return true;
  if ((el.inputMode || "").toLowerCase() === "numeric") return true;
  return false;
}

function setNativeValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && typeof desc.set === "function") desc.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findOtpTarget() {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && isVisible(active) && isTextLikeInput(active) && likelyOtp(active)) {
    return { kind: "single", input: active };
  }

  const all = Array.from(document.querySelectorAll("input"));

  // Prefer multi-input OTP widgets (maxlength=1).
  const candidates = all
    .filter((el) => el instanceof HTMLInputElement)
    .filter(isVisible)
    .filter(isTextLikeInput)
    .filter(likelyOtp)
    .filter((el) => el.maxLength === 1);

  if (candidates.length >= 4 && candidates.length <= 8) {
    // Sort left-to-right, top-to-bottom.
    const sorted = candidates.slice().sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 10) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    return { kind: "group", inputs: sorted };
  }

  // Fallback: single input most likely to be OTP.
  const singles = all
    .filter((el) => el instanceof HTMLInputElement)
    .filter(isVisible)
    .filter(isTextLikeInput)
    .filter(likelyOtp)
    .filter((el) => el.maxLength !== 1);

  if (singles.length) return { kind: "single", input: singles[0] };
  return null;
}

function toast(level, message) {
  const el = document.createElement("div");
  el.textContent = message;
  el.style.position = "fixed";
  el.style.zIndex = "2147483647";
  el.style.top = "16px";
  el.style.right = "16px";
  el.style.maxWidth = "360px";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "10px";
  el.style.font = "13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
  el.style.boxShadow = "0 8px 24px rgba(0,0,0,.18)";
  el.style.color = "#111";
  el.style.background = level === "error" ? "#ffe3e3" : level === "info" ? "#e8f1ff" : "#eee";
  el.style.border = "1px solid rgba(0,0,0,.08)";
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "OTP_TOAST") {
      toast(msg.level || "info", msg.message || "");
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "OTP_FILL") {
      const code = String(msg.code || "").replace(/\D/g, "");
      if (code.length < 4) {
        sendResponse({ ok: false, error: "invalid_code" });
        return;
      }

      const target = findOtpTarget();
      if (!target) {
        sendResponse({ ok: false, error: "no_otp_field" });
        return;
      }

      if (target.kind === "single") {
        target.input.focus();
        setNativeValue(target.input, code);
        sendResponse({ ok: true });
        return;
      }

      const digits = code.split("");
      const inputs = target.inputs.slice(0, digits.length);
      for (let i = 0; i < inputs.length; i++) {
        inputs[i].focus();
        setNativeValue(inputs[i], digits[i] || "");
      }
      sendResponse({ ok: true });
      return;
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));

  return true;
});

