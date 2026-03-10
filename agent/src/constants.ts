export const APP_ID = "email-otp-autofill";

export const AGENT_HOST = process.env.OTP_AGENT_HOST?.trim() || "127.0.0.1";
export const AGENT_PORT = (() => {
  const raw = process.env.OTP_AGENT_PORT?.trim();
  if (!raw) return 17373;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 65536) return 17373;
  return Math.floor(n);
})();

// Cheap CSRF-ish guard: websites can't send custom headers without CORS preflight.
export const CLIENT_HEADER_NAME = "x-otp-agent-client";
export const CLIENT_HEADER_VALUE = APP_ID;

export const API_KEY_HEADER_NAME = "x-otp-agent-key";
export const API_KEY = process.env.OTP_AGENT_API_KEY?.trim() || "";

const HOME = process.env.HOME?.trim() || "/tmp";

export const DATA_DIR =
  process.env.OTP_AGENT_DATA_DIR?.trim() ||
  process.env.XDG_CONFIG_HOME?.trim() ||
  `${HOME}/.config/${APP_ID}`;

export const CONFIG_PATH = `${DATA_DIR}/config.json`;
export const SECRETS_PATH = `${DATA_DIR}/secrets.json`;
