// RFC 5849 OAuth 1.0a HMAC-SHA1 signature and Authorization header utility,
// via WebCrypto. Used by X (Twitter) Ads API v12 and organic API v2.
// Port of the old lib/oauth1.js.

export function percentEncode(str: unknown): string {
  return encodeURIComponent(String(str ?? "")).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const te = new TextEncoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export interface OAuth1Config {
  consumerKey: string;
  consumerSecret: string;
  accessToken?: string;
  accessTokenSecret?: string;
}

/**
 * Generate an OAuth 1.0a Authorization header (RFC 5849, HMAC-SHA1).
 */
export async function generateOAuth1Header(
  method: string,
  url: string,
  config: OAuth1Config,
  params: Record<string, string> = {},
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.consumerKey || "",
    oauth_nonce: [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
  };
  if (config.accessToken) {
    oauthParams.oauth_token = config.accessToken;
  }

  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    percentEncode(url.split("?")[0]),
    percentEncode(paramString),
  ].join("&");
  const signingKey = `${percentEncode(config.consumerSecret || "")}&${percentEncode(config.accessTokenSecret || "")}`;

  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(baseString));
  oauthParams.oauth_signature = b64encode(new Uint8Array(sig));

  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("oauth_")) {
      oauthParams[k] = v;
    }
  }

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");
  return `OAuth ${headerParts}`;
}

/** Perform a fetch request signed with OAuth 1.0a. */
export async function makeOAuth1Request(
  method: string,
  url: string,
  oauth: OAuth1Config,
  params: Record<string, string> = {},
  init: RequestInit = {},
): Promise<any> {
  const cleanUrl = url.split("?")[0] ?? url;
  let requestUrl = url;
  let body: string | undefined;
  const signatureParams = { ...params };

  if (method === "GET") {
    const qs = new URLSearchParams(Object.entries(params)).toString();
    if (qs) requestUrl = `${cleanUrl}?${qs}`;
  } else {
    body = new URLSearchParams(Object.entries(params)).toString();
  }

  const authHeader = await generateOAuth1Header(method, cleanUrl, oauth, signatureParams);
  const headers: Record<string, string> = {
    Authorization: authHeader,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (method !== "GET" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const response = await fetch(requestUrl, {
    method,
    headers,
    body: method !== "GET" ? body : undefined,
    signal: AbortSignal.timeout(30000),
    ...init,
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const errorMsg =
      data?.errors?.[0]?.message ||
      data?.error_description ||
      data?.error ||
      data?.detail ||
      data?.title ||
      `HTTP ${response.status}: ${text.slice(0, 200)}`;
    const err = new Error(`X API error: ${errorMsg}`) as Error & { status?: number; data?: unknown };
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}
