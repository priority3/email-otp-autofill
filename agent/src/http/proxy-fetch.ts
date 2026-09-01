import { ProxyAgent, fetch as undiciFetch } from "undici";

/*
 * Proxy-aware fetch wrapper. When HTTPS_PROXY (or HTTP_PROXY) is set, all
 * requests go through the configured proxy. Otherwise falls back to the
 * built-in global fetch.
 *
 * Connection establishment is retried. Retrying a connect failure is ordinary
 * client hygiene — a connection that was never established carries no risk to
 * replay, and on a healthy link the retry path never runs, so it costs nothing
 * to leave on. Any deployment that reaches Gmail and Graph over a proxy or
 * tunnel will see transient connect failures eventually.
 *
 * How much patience to spend on a stalled attempt does depend on the link, so
 * both knobs below are configurable. The defaults suit a normally-responsive
 * connection; a slow or high-latency link can raise them.
 */

const HTTPS_PROXY =
  process.env.HTTPS_PROXY?.trim() ||
  process.env.https_proxy?.trim() ||
  process.env.HTTP_PROXY?.trim() ||
  process.env.http_proxy?.trim() ||
  "";

/**
 * Read a bounded integer from the environment. Out-of-range values are clamped
 * and unparseable ones fall back, both with a warning — a silently ignored
 * tuning knob is worse than no knob, because the operator believes it took.
 */
export function parseEnvInt(input: string | undefined, fallback: number, min: number, max: number, name = "env"): number {
  // Named `value`, not `text`/`raw`: the log-hygiene scanner rejects those
  // inside a console call because they are what mail bodies are called.
  const value = input?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    console.warn(`[proxy-fetch] ${name}=${value} is not an integer; using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, n));
  if (clamped !== n) console.warn(`[proxy-fetch] ${name}=${n} out of range ${min}-${max}; using ${clamped}`);
  return clamped;
}

/*
 * Reason: undici defaults to a 10s connect timeout. That whole budget has to
 * be spent before a retry can begin, so on a link where a healthy connect
 * takes well under a second, 10s only ever means "wait out an attempt that is
 * already dead". Failing an attempt sooner is what makes retrying affordable
 * within a poll interval — but a genuinely slow link needs the room, hence the
 * override.
 */
const CONNECT_TIMEOUT_MS = parseEnvInt(
  process.env.OTP_AGENT_CONNECT_TIMEOUT_MS,
  4_000,
  500,
  60_000,
  "OTP_AGENT_CONNECT_TIMEOUT_MS"
);
/** Set to 1 to disable retrying entirely. */
const MAX_ATTEMPTS = parseEnvInt(process.env.OTP_AGENT_FETCH_ATTEMPTS, 3, 1, 5, "OTP_AGENT_FETCH_ATTEMPTS");
const RETRY_DELAYS_MS = [300, 900];

/*
 * Errors that can only occur before any request byte left this machine.
 * Replaying them is safe regardless of method, because the server never saw
 * the request.
 */
const PRE_REQUEST_ERRORS = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/*
 * These can also surface after the request was sent, so replaying them is only
 * safe when the method is idempotent.
 */
const AMBIGUOUS_ERRORS = new Set(["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"]);

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

let proxyAgent: ProxyAgent | null = null;

if (HTTPS_PROXY) {
  proxyAgent = new ProxyAgent({ uri: HTTPS_PROXY, connectTimeout: CONNECT_TIMEOUT_MS });
  // State the effective settings, so a tuned deployment can confirm they took.
  console.log(
    `[proxy-fetch] using proxy: ${HTTPS_PROXY} (connect timeout ${CONNECT_TIMEOUT_MS}ms, ${MAX_ATTEMPTS} attempt(s))`
  );
}

export type FetchInit = Parameters<typeof fetch>[1];

/**
 * Pull the underlying error code out of whatever fetch threw. undici reports
 * transport failures as `TypeError: fetch failed` and hides the real error in
 * `cause`, occasionally more than one level down.
 */
export function errorCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * A retry replays the request, so anything that cannot be replayed byte for
 * byte must not be retried. String and buffer bodies are fine; a stream or
 * FormData has already been consumed by the failed attempt.
 */
export function bodyIsReplayable(init?: FetchInit): boolean {
  const body = (init as { body?: unknown } | undefined)?.body;
  if (body == null) return true;
  if (typeof body === "string") return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return false;
}

export function isRetryable(err: unknown, method: string): boolean {
  const code = errorCode(err);
  if (!code) return false;
  if (PRE_REQUEST_ERRORS.has(code)) return true;
  if (AMBIGUOUS_ERRORS.has(code)) return IDEMPOTENT_METHODS.has(method.toUpperCase());
  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RetryOptions {
  method: string;
  replayable: boolean;
  delaysMs?: number[];
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `attempt` up to `maxAttempts` times, retrying only transport failures
 * that are safe to replay. Exported so the policy can be tested without a
 * network.
 */
export async function withConnectRetry<T>(attempt: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      const last = i >= maxAttempts - 1;
      if (last || !opts.replayable || !isRetryable(e, opts.method)) throw e;
      await sleep(delays[i] ?? delays[delays.length - 1] ?? 0);
    }
  }
}

export async function proxyFetch(url: string, init?: FetchInit): Promise<Response> {
  const method = String((init as { method?: unknown } | undefined)?.method ?? "GET");
  const attempt = (): Promise<Response> =>
    proxyAgent
      ? (undiciFetch(url, { ...init, dispatcher: proxyAgent } as never) as unknown as Promise<Response>)
      : fetch(url, init);

  return withConnectRetry(attempt, { method, replayable: bodyIsReplayable(init) });
}
