import { ProxyAgent, fetch as undiciFetch } from "undici";

/*
 * Proxy-aware fetch wrapper. When HTTPS_PROXY (or HTTP_PROXY) is set, all
 * requests go through the configured proxy. Otherwise falls back to the
 * built-in global fetch.
 */

const HTTPS_PROXY =
  process.env.HTTPS_PROXY?.trim() ||
  process.env.https_proxy?.trim() ||
  process.env.HTTP_PROXY?.trim() ||
  process.env.http_proxy?.trim() ||
  "";

let proxyAgent: ProxyAgent | null = null;

if (HTTPS_PROXY) {
  proxyAgent = new ProxyAgent(HTTPS_PROXY);
  console.log(`[proxy-fetch] using proxy: ${HTTPS_PROXY}`);
}

export type FetchInit = Parameters<typeof fetch>[1];

export async function proxyFetch(
  url: string,
  init?: FetchInit
): Promise<Response> {
  if (!proxyAgent) return fetch(url, init);
  return undiciFetch(url, {
    ...init,
    dispatcher: proxyAgent,
  } as any) as unknown as Promise<Response>;
}
