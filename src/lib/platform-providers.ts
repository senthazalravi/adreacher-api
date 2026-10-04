// OAuth + account discovery per ad platform. Port of the old
// lib/platform-providers.js (token flows only; publishing/analytics live in
// Phase 4). Each provider: authUrl(cfg, redirectUri, state) → url,
// exchange(cfg, code, redirectUri, verifier) → TokenSet,
// refresh(cfg, refreshToken) → TokenSet,
// account(cfg, tokens) → AccountInfo.
// Pure fetch + WebCrypto — no Node APIs.

import { generateOAuth1Header, makeOAuth1Request } from "./oauth1.js";

export interface PlatformCfg {
  clientId?: string | null;
  clientSecret?: string | null;
  developerToken?: string | null;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  scopes?: string[];
  apiVersion?: string | null;
  oauthVersion?: number | string | null;
  extra?: Record<string, any>;
  [k: string]: unknown;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  scopes?: string[];
  meta?: Record<string, any>;
}

export interface AccountIssue {
  code: string;
  message: string;
}

export interface AccountInfo {
  externalAccountId: string;
  externalAccountName: string;
  currency?: string;
  meta: Record<string, any>;
  issues: AccountIssue[];
}

export interface Provider {
  apiKey?: boolean;
  authUrl?: (
    cfg: PlatformCfg,
    redirectUri: string,
    state: string,
    env?: Record<string, string | undefined>,
  ) => Promise<string> | string;
  exchange?: (
    cfg: PlatformCfg,
    codeOrVerifier: string,
    redirectUri: string,
    verifier?: string,
    extra?: Record<string, string>,
  ) => Promise<TokenSet>;
  refresh?: (
    cfg: PlatformCfg,
    refreshToken: string,
    current?: string,
  ) => Promise<TokenSet>;
  account?: (
    cfg: PlatformCfg,
    tokens: TokenSet,
    opts?: { linkMerchantCenter?: (args: Record<string, unknown>, merchantId: string) => Promise<void> },
  ) => Promise<AccountInfo>;
}

type EnvLike = Record<string, string | undefined>;

const te = new TextEncoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decodeToString(b64: string): string {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const form = (o: Record<string, unknown>): string =>
  new URLSearchParams(
    Object.entries(o).filter(([, v]) => v != null && v !== "") as [string, string][],
  ).toString();

class ProviderError extends Error {
  status?: number;
  body?: unknown;
}

async function json(url: string, init: RequestInit = {}, label = "request"): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const msg =
      data?.error_description ||
      data?.error?.message ||
      data?.message ||
      data?.error ||
      `${label} failed (${r.status})`;
    const e = new ProviderError(typeof msg === "string" ? msg : JSON.stringify(msg));
    (e as any).status = r.status;
    (e as any).body = data;
    throw e;
  }
  return data;
}

const postForm = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: form(body),
    },
    "token exchange",
  );

const basic = (id: string, secret: string) => ({
  Authorization: `Basic ${b64encode(te.encode(`${id}:${secret}`))}`,
});

/**
 * Google Ads API version to call. Google sunsets old versions and then serves
 * an HTML 404 for every request against them — so a stale adsApiVersion in the
 * stored config is ignored below the minimum.
 */
const GOOGLE_ADS_API_VERSION = "v23";
const GOOGLE_ADS_MIN_MAJOR = 22;
export function googleAdsVersion(cfg?: PlatformCfg | null): string {
  const configured = (cfg?.extra?.adsApiVersion as string | undefined) || (cfg?.apiVersion as string | undefined);
  const major =
    typeof configured === "string" ? Number((/^v(\d+)$/.exec(configured.trim()) || [])[1]) : NaN;
  return Number.isFinite(major) && major >= GOOGLE_ADS_MIN_MAJOR
    ? (configured as string).trim()
    : GOOGLE_ADS_API_VERSION;
}

/* ---------------- Google Ads ---------------- */
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
/** Google Ads API OAuth scope — required by Google; the request is rejected without it. */
const GOOGLE_ADS_SCOPES = ["https://www.googleapis.com/auth/adwords"];
const google: Provider = {
  authUrl: (cfg, redirectUri, state) =>
    `${cfg.authorizeUrl || "https://accounts.google.com/o/oauth2/v2/auth"}?${form({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: (cfg.scopes?.length ? cfg.scopes : GOOGLE_ADS_SCOPES).join(" "),
      response_type: "code",
      state,
      access_type: "offline",
      prompt: "consent",
    })}`,
  exchange: async (cfg, code, redirectUri) => {
    const d = await postForm(GOOGLE_TOKEN, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (!d.access_token) throw new Error("Google did not return an access token");
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in };
  },
  refresh: async (cfg, refreshToken) => {
    const d = await postForm(GOOGLE_TOKEN, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return { accessToken: d.access_token, refreshToken, expiresIn: d.expires_in };
  },
  account: async (cfg, t, opts) => {
    const env = (opts as any)?.env as EnvLike | undefined;
    const me = await json(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${t.accessToken}` } },
      "Google account info",
    ).catch(() => ({}));
    const meta: Record<string, any> = {
      email: me.email,
      googleUserId: me.id,
      customers: [],
      managerCustomerId: cfg.extra?.managerCustomerId || null,
    };
    const issues: AccountIssue[] = [];
    const ver = googleAdsVersion(cfg);
    const devToken = cfg.developerToken;
    if (devToken) {
      try {
        const d = await json(
          `https://googleads.googleapis.com/${ver}/customers:listAccessibleCustomers`,
          {
            headers: {
              Authorization: `Bearer ${t.accessToken}`,
              "developer-token": devToken,
            },
          },
          "Google Ads customers",
        );
        const ids: string[] = (d.resourceNames || []).map((r: string) => r.split("/").pop()!);
        for (const id of ids) {
          let isManager = false,
            queryable = false;
          try {
            const q = await json(
              `https://googleads.googleapis.com/${ver}/customers/${id}/googleAds:searchStream`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${t.accessToken}`,
                  "developer-token": devToken,
                  "login-customer-id": id,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  query:
                    "SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code FROM customer LIMIT 1",
                }),
              },
              "Google Ads customer",
            );
            const c = q?.[0]?.results?.[0]?.customer;
            queryable = true;
            isManager = c?.manager === true;
            meta.customers.push({
              id,
              name: c?.descriptiveName || id,
              isManager,
              currency: c?.currencyCode,
            });
          } catch {
            meta.customers.push({ id, name: id, isManager: false, queryable: false });
          }
          if (queryable && !isManager && !meta.selectedAdAccountId) meta.selectedAdAccountId = id;
          if (queryable && isManager && !meta.managerCustomerId) meta.managerCustomerId = id;

          if (queryable && isManager) {
            try {
              const kids = await json(
                `https://googleads.googleapis.com/${ver}/customers/${id}/googleAds:searchStream`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${t.accessToken}`,
                    "developer-token": devToken,
                    "login-customer-id": id,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    query:
                      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code FROM customer_client WHERE customer_client.level <= 1",
                  }),
                },
                "Google Ads client accounts",
              );
              for (const row of (kids || []).flatMap((c: any) => c?.results || [])) {
                const cc = row.customerClient || {};
                const cid = String(cc.id || "");
                if (!cid || cc.manager === true || meta.customers.some((x: any) => x.id === cid)) continue;
                meta.customers.push({
                  id: cid,
                  name: cc.descriptiveName || cid,
                  isManager: false,
                  currency: cc.currencyCode,
                  managedBy: id,
                });
                if (!meta.selectedAdAccountId) meta.selectedAdAccountId = cid;
              }
            } catch {
              /* the manager itself is still listed; the user can pick manually */
            }
          }
        }
        if (!meta.selectedAdAccountId && ids.length) meta.selectedAdAccountId = ids[0];
      } catch (e) {
        issues.push({
          code: "ads_accounts_unavailable",
          message: `Could not list Google Ads accounts: ${(e as Error).message}`,
        });
      }
    } else {
      issues.push({
        code: "no_developer_token",
        message: "Google Ads developer token is not configured",
      });
    }

    // Auto-discover Google Merchant Center Account ID
    let discoveredMerchantId = env?.GOOGLE_MERCHANT_CENTER_ID
      ? String(env.GOOGLE_MERCHANT_CENTER_ID).trim()
      : "";
    if (!discoveredMerchantId) {
      try {
        const mRes = await fetch("https://merchantapi.googleapis.com/accounts/v1beta/accounts", {
          headers: { Authorization: `Bearer ${t.accessToken}` },
          signal: AbortSignal.timeout(8000),
        });
        if (mRes.ok) {
          const mData: any = await mRes.json();
          const first = (mData.accounts || [])[0];
          const mId = first?.accountId || (first?.name ? first.name.split("/").pop() : null);
          if (mId) discoveredMerchantId = String(mId);
        }
      } catch {
        /* ignore */
      }
    }
    if (!discoveredMerchantId) {
      try {
        const mcRes = await fetch(
          "https://shoppingcontent.googleapis.com/content/v2.1/accounts/authinfo",
          {
            headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(8000),
          },
        );
        if (mcRes.ok) {
          const mcData: any = await mcRes.json();
          const firstAccount = (mcData.accountIdentifiers || [])[0];
          const mId = String(firstAccount?.merchantId || firstAccount?.accountId || "").trim();
          if (mId) discoveredMerchantId = mId;
        }
      } catch {
        /* ignore */
      }
    }
    if (discoveredMerchantId) {
      meta.merchantCenterId = discoveredMerchantId;
      if (devToken && meta.selectedAdAccountId && opts?.linkMerchantCenter) {
        await opts
          .linkMerchantCenter(
            {
              customerId: meta.selectedAdAccountId,
              accessToken: t.accessToken,
              developerToken: devToken,
              loginCustomerId: meta.managerCustomerId || meta.selectedAdAccountId,
              apiVersion: ver,
            },
            discoveredMerchantId,
          )
          .catch(() => null);
      }
    }

    if (!meta.selectedAdAccountId)
      issues.push({ code: "no_ad_account", message: "No Google Ads customer account found for this login" });
    else if (meta.customers.find((c: any) => c.id === meta.selectedAdAccountId)?.isManager)
      issues.push({
        code: "manager_account_selected",
        message:
          "This is a manager (MCC) account and cannot hold campaigns. Pick one of its client accounts in Connections.",
      });
    const sel = meta.customers.find((c: any) => c.id === meta.selectedAdAccountId);
    return {
      externalAccountId: meta.selectedAdAccountId || me.id || "google",
      externalAccountName: sel?.name
        ? `${sel.name} · customer ${meta.selectedAdAccountId}`
        : me.email || "Google account",
      currency: sel?.currency,
      meta,
      issues,
    };
  },
};

/* ---------------- Meta (Facebook / Instagram) ---------------- */
const meta: Provider = {
  authUrl: (cfg, redirectUri, state) =>
    `${cfg.authorizeUrl || "https://www.facebook.com/v21.0/dialog/oauth"}?${form({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: (cfg.scopes || []).join(","),
      response_type: "code",
      state,
    })}`,
  exchange: async (cfg, code, redirectUri) => {
    const g = `https://graph.facebook.com/${(cfg.extra?.graphApiVersion as string) || "v21.0"}`;
    const short = await json(
      `${g}/oauth/access_token?${form({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: redirectUri,
        code,
      })}`,
      {},
      "Meta token exchange",
    );
    if (!short.access_token) throw new Error("Meta did not return an access token");
    const long = await json(
      `${g}/oauth/access_token?${form({
        grant_type: "fb_exchange_token",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        fb_exchange_token: short.access_token,
      })}`,
      {},
      "Meta long-lived token",
    ).catch(() => ({}));
    return {
      accessToken: long.access_token || short.access_token,
      expiresIn: long.expires_in || short.expires_in || 60 * 24 * 3600,
    };
  },
  refresh: async (cfg, _rt, current) => {
    const g = `https://graph.facebook.com/${(cfg.extra?.graphApiVersion as string) || "v21.0"}`;
    const d = await json(
      `${g}/oauth/access_token?${form({
        grant_type: "fb_exchange_token",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        fb_exchange_token: current,
      })}`,
      {},
      "Meta token refresh",
    );
    return { accessToken: d.access_token, expiresIn: d.expires_in };
  },
  account: async (cfg, t) => {
    const g = `https://graph.facebook.com/${(cfg.extra?.graphApiVersion as string) || "v21.0"}`;
    const at = t.accessToken;
    const issues: AccountIssue[] = [];
    const me = await json(
      `${g}/me?${form({ access_token: at, fields: "id,name,email" })}`,
      {},
      "Meta account info",
    );
    const pages = (
      (
        await json(
          `${g}/me/accounts?${form({ access_token: at, fields: "id,name,category" })}`,
          {},
          "Meta pages",
        ).catch(() => ({ data: [] }))
      ).data || []
    ).map((p: any) => ({ id: p.id, name: p.name, category: p.category }));
    const acctFields = "id,name,account_status,currency";
    const found = new Map<string, any>();
    const add = (rows: any[]) =>
      (rows || []).forEach(
        (a) =>
          a?.id &&
          !found.has(a.id) &&
          found.set(a.id, {
            id: a.id,
            name: a.name || a.id,
            accountStatus: a.account_status ?? 0,
            currency: a.currency,
          }),
      );
    add(
      (
        await json(
          `${g}/me/adaccounts?${form({ access_token: at, fields: acctFields, limit: 100 })}`,
          {},
          "Meta ad accounts",
        ).catch(() => ({}))
      ).data,
    );
    const biz =
      (
        await json(
          `${g}/me/businesses?${form({ access_token: at, fields: "id,name", limit: 50 })}`,
          {},
          "Meta businesses",
        ).catch(() => ({ data: [] }))
      ).data || [];
    for (const b of biz)
      for (const edge of ["owned_ad_accounts", "client_ad_accounts"])
        add(
          (
            await json(
              `${g}/${b.id}/${edge}?${form({ access_token: at, fields: acctFields, limit: 100 })}`,
              {},
              "Meta business ad accounts",
            ).catch(() => ({}))
          ).data,
        );
    const adAccounts = [...found.values()].sort(
      (a, b) => (a.accountStatus === 1 ? -1 : 1) - (b.accountStatus === 1 ? -1 : 1) || a.name.localeCompare(b.name),
    );
    const selected = adAccounts[0];
    if (!selected)
      issues.push({ code: "no_ad_account", message: "No Meta ad account is accessible with this login" });
    if (!pages.length) issues.push({ code: "no_page", message: "No Facebook Page found — ads need a Page to run from" });
    return {
      externalAccountId: selected?.id || me.id,
      externalAccountName: selected ? `${selected.name} · ad account + page` : me.name,
      currency: selected?.currency,
      meta: {
        metaUserId: me.id,
        name: me.name,
        email: me.email,
        pages,
        adAccounts,
        selectedAdAccountId: selected?.id || null,
        selectedPageId: pages[0]?.id || null,
        businesses: biz.map((b: any) => ({ id: b.id, name: b.name })),
      },
      issues,
    };
  },
};

/* ---------------- TikTok Ads ---------------- */
const TT = "https://business-api.tiktok.com/open_api/v1.3";
const tiktok: Provider = {
  authUrl: (cfg, redirectUri, state) =>
    `https://business-api.tiktok.com/portal/auth?${form({
      app_id: cfg.clientId,
      redirect_uri: redirectUri,
      state,
    })}`,
  exchange: async (cfg, code) => {
    const d = await json(
      `${TT}/oauth2/access_token/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: cfg.clientId, secret: cfg.clientSecret, auth_code: code }),
      },
      "TikTok token exchange",
    );
    if (d.code && d.code !== 0) throw new Error(d.message || `TikTok error ${d.code}`);
    const p = d.data || {};
    if (!p.access_token) throw new Error("TikTok did not return an access token");
    return {
      accessToken: p.access_token,
      refreshToken: p.refresh_token,
      expiresIn: p.expires_in,
      meta: { advertiserIds: p.advertiser_ids || [] },
    };
  },
  refresh: async () => {
    throw new Error("TikTok Marketing API tokens are long-lived; reconnect if revoked");
  },
  account: async (cfg, t) => {
    const issues: AccountIssue[] = [];
    let list: Array<{ id: string; name: string }> = [];
    try {
      const d = await json(
        `${TT}/oauth2/advertiser/get/?${form({ app_id: cfg.clientId, secret: cfg.clientSecret })}`,
        { headers: { "Access-Token": t.accessToken } },
        "TikTok advertisers",
      );
      list = (d.data?.list || []).map((a: any) => ({
        id: String(a.advertiser_id),
        name: a.advertiser_name || `Advertiser ${a.advertiser_id}`,
      }));
    } catch (e) {
      issues.push({ code: "ads_accounts_unavailable", message: (e as Error).message });
    }
    if (!list.length && t.meta?.advertiserIds?.length)
      list = t.meta.advertiserIds.map((id: string | number) => ({
        id: String(id),
        name: `Advertiser ${id}`,
      }));
    if (!list.length)
      issues.push({ code: "no_ad_account", message: "No TikTok advertiser account is authorized for this login" });
    return {
      externalAccountId: list[0]?.id || "tiktok",
      externalAccountName: list[0]?.name || "TikTok Ads account",
      meta: { adAccounts: list, selectedAdAccountId: list[0]?.id || null },
      issues,
    };
  },
};

/* ---------------- Reddit Ads ---------------- */
const RA = "https://ads-api.reddit.com/api/v3";
const UA = "reach-api/1.0";
const reddit: Provider = {
  authUrl: (cfg, redirectUri, state) =>
    `${cfg.authorizeUrl || "https://www.reddit.com/api/v1/authorize"}?${form({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: (cfg.scopes || []).join(" "),
      response_type: "code",
      state,
      duration: "permanent",
    })}`,
  exchange: async (cfg, code, redirectUri) => {
    const d = await postForm(
      "https://www.reddit.com/api/v1/access_token",
      { grant_type: "authorization_code", code, redirect_uri: redirectUri },
      { ...basic(cfg.clientId || "", cfg.clientSecret || ""), "User-Agent": UA },
    );
    if (!d.access_token) throw new Error(d.error || "Reddit did not return an access token");
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in };
  },
  refresh: async (cfg, rt) => {
    const d = await postForm(
      "https://www.reddit.com/api/v1/access_token",
      { grant_type: "refresh_token", refresh_token: rt },
      { ...basic(cfg.clientId || "", cfg.clientSecret || ""), "User-Agent": UA },
    );
    return { accessToken: d.access_token, refreshToken: d.refresh_token || rt, expiresIn: d.expires_in };
  },
  account: async (cfg, t) => {
    const H = { headers: { Authorization: `Bearer ${t.accessToken}`, "User-Agent": UA } };
    const issues: AccountIssue[] = [];
    const me = (await json(`${RA}/me`, H, "Reddit account").catch(() => ({}))).data || {};
    const accounts: Array<Record<string, any>> = [];
    try {
      const bz = (await json(`${RA}/me/businesses`, H, "Reddit businesses")).data || [];
      for (const b of bz) {
        const aa = (await json(`${RA}/businesses/${b.id}/ad_accounts`, H, "Reddit ad accounts").catch(() => ({}))).data || [];
        for (const a of aa)
          accounts.push({ id: a.id, name: a.name || a.id, businessId: b.id, currency: a.currency });
      }
    } catch (e) {
      issues.push({ code: "ads_accounts_unavailable", message: (e as Error).message });
    }
    if (!accounts.length)
      issues.push({ code: "no_ad_account", message: "No Reddit Ads account found for this login" });
    return {
      externalAccountId: accounts[0]?.id || me.id || "reddit",
      externalAccountName: accounts[0]?.name || me.name || me.username || "Reddit Ads account",
      currency: accounts[0]?.currency,
      meta: {
        redditUserId: me.id,
        username: me.username || me.name,
        adAccounts: accounts,
        selectedAdAccountId: accounts[0]?.id || null,
        businessId: accounts[0]?.businessId || null,
      },
      issues,
    };
  },
};

/* ---------------- Pinterest Ads ---------------- */
const PI = "https://api.pinterest.com/v5";
const pinterest: Provider = {
  authUrl: (cfg, redirectUri, state) =>
    `${cfg.authorizeUrl || "https://www.pinterest.com/oauth/"}?${form({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: (cfg.scopes || []).join(","),
      response_type: "code",
      state,
    })}`,
  exchange: async (cfg, code, redirectUri) => {
    const d = await postForm(
      `${PI}/oauth/token`,
      { grant_type: "authorization_code", code, redirect_uri: redirectUri },
      basic(cfg.clientId || "", cfg.clientSecret || ""),
    );
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in };
  },
  refresh: async (cfg, rt) => {
    const d = await postForm(
      `${PI}/oauth/token`,
      { grant_type: "refresh_token", refresh_token: rt },
      basic(cfg.clientId || "", cfg.clientSecret || ""),
    );
    return { accessToken: d.access_token, refreshToken: d.refresh_token || rt, expiresIn: d.expires_in };
  },
  account: async (cfg, t) => {
    const H = { headers: { Authorization: `Bearer ${t.accessToken}` } };
    const issues: AccountIssue[] = [];
    const me = await json(`${PI}/user_account`, H, "Pinterest account").catch(() => ({}));
    const accounts = (
      (await json(`${PI}/ad_accounts`, H, "Pinterest ad accounts").catch(() => ({ items: [] }))).items || []
    ).map((a: any) => ({ id: a.id, name: a.name || a.id, currency: a.currency }));
    if (!accounts.length)
      issues.push({ code: "no_ad_account", message: "No Pinterest ad account found for this login" });
    return {
      externalAccountId: accounts[0]?.id || me.username || "pinterest",
      externalAccountName: accounts[0]?.name || me.business_name || me.username || "Pinterest account",
      currency: accounts[0]?.currency,
      meta: {
        username: me.username,
        adAccounts: accounts,
        selectedAdAccountId: accounts[0]?.id || null,
      },
      issues,
    };
  },
};

/* ---------------- Microsoft Advertising (Bing Ads) ---------------- */
const BING_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const BING_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const BING_DEFAULT_SCOPES = [
  "https://ads.microsoft.com/msads.manage",
  "offline_access",
  "openid",
  "profile",
  "email",
];

const bing: Provider = {
  authUrl: (cfg, redirectUri, state) =>
    `${cfg.authorizeUrl || BING_AUTH}?${form({
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: (cfg.scopes?.length ? cfg.scopes : BING_DEFAULT_SCOPES).join(" "),
      state,
    })}`,
  exchange: async (cfg, code, redirectUri, verifier) => {
    const p: Record<string, unknown> = {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    };
    if (verifier) p.code_verifier = verifier;
    const d = await postForm(BING_TOKEN, p);
    if (!d.access_token)
      throw new Error(d.error_description || d.error || "Microsoft did not return an access token");
    return {
      accessToken: d.id_token ? `${d.access_token}:::${d.id_token}` : d.access_token,
      refreshToken: d.refresh_token,
      expiresIn: d.expires_in,
    };
  },
  refresh: async (cfg, refreshToken) => {
    const scopes = cfg.scopes?.length ? cfg.scopes : BING_DEFAULT_SCOPES;
    const d = await postForm(BING_TOKEN, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: scopes.join(" "),
    });
    if (!d.access_token)
      throw new Error(d.error_description || d.error || "Microsoft did not return an access token on refresh");
    return {
      accessToken: d.id_token ? `${d.access_token}:::${d.id_token}` : d.access_token,
      refreshToken: d.refresh_token || refreshToken,
      expiresIn: d.expires_in,
    };
  },
  account: async (cfg, t) => {
    const issues: AccountIssue[] = [];
    const parts = (t.accessToken || "").split(":::");
    const tokenToDecode = parts.length > 1 ? (parts[1] as string) : (parts[0] as string);
    const realToken = parts[0] as string;

    let email: string | null = null,
      name = "Bing Ads User",
      userId: string | null = null;
    try {
      const payloadBase64 = tokenToDecode.split(".")[1];
      if (payloadBase64) {
        const decoded = JSON.parse(b64decodeToString(payloadBase64));
        email = decoded.email || decoded.upn || decoded.unique_name || null;
        name = decoded.name || email || "Bing Ads User";
        userId = decoded.oid || decoded.sub || null;
      }
    } catch {
      /* ignore */
    }

    const devToken =
      cfg.developerToken || (cfg as any).env?.ADS_BING_ADS_DEVELOPER_TOKEN || "145DN08F29379687";
    const CUSTOMER_MANAGEMENT_API =
      "https://clientcenter.api.bingads.microsoft.com/Api/CustomerManagement/v13/CustomerManagementService.svc";

    const adAccounts: Array<Record<string, any>> = [];
    if (devToken && realToken) {
      try {
        const getUserXml = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header xmlns="https://bingads.microsoft.com/Customer/v13">
    <Action mustUnderstand="1">GetUser</Action>
    <AuthenticationToken>${realToken}</AuthenticationToken>
    <DeveloperToken>${devToken}</DeveloperToken>
  </s:Header>
  <s:Body>
    <GetUserRequest xmlns="https://bingads.microsoft.com/Customer/v13">
      <UserId i:nil="true" />
    </GetUserRequest>
  </s:Body>
</s:Envelope>`;
        const userRes = await fetch(CUSTOMER_MANAGEMENT_API, {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "GetUser" },
          body: getUserXml,
          signal: AbortSignal.timeout(20000),
        });
        const userText = await userRes.text();

        if (userRes.ok && !userText.includes("<s:Fault>")) {
          const customerIdMatch = userText.match(
            /<[a-zA-Z0-9]*:?CustomerId>(\d+)<\/[a-zA-Z0-9]*:?CustomerId>/i,
          );
          const customerId = customerIdMatch?.[1];
          const userWithoutContact = userText.replace(
            /<[a-zA-Z0-9]*:?ContactInfo>[\s\S]*?<\/[a-zA-Z0-9]*:?ContactInfo>/gi,
            "",
          );
          const parsedUserId = (
            userWithoutContact.match(
              /<[a-zA-Z0-9]*:?User[^>]*>[\s\S]*?<[a-zA-Z0-9]*:?Id>(\d+)<\/[a-zA-Z0-9]*:?Id>/i,
            ) ||
            userText.match(
              /<[a-zA-Z0-9]*:?CustomerId>\d+<\/[a-zA-Z0-9]*:?CustomerId>\s*<[a-zA-Z0-9]*:?Id>(\d+)<\/[a-zA-Z0-9]*:?Id>/i,
            )
          )?.[1];
          const queryUserId = parsedUserId || userId;

          if (queryUserId) {
            const searchAccountsXml = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header xmlns="https://bingads.microsoft.com/Customer/v13">
    <Action mustUnderstand="1">SearchAccounts</Action>
    <AuthenticationToken>${realToken}</AuthenticationToken>
    <DeveloperToken>${devToken}</DeveloperToken>
  </s:Header>
  <s:Body>
    <SearchAccountsRequest xmlns="https://bingads.microsoft.com/Customer/v13">
      <Predicates xmlns:a="https://bingads.microsoft.com/Customer/v13/Entities">
        <a:Predicate>
          <a:Field>UserId</a:Field>
          <a:Operator>Equals</a:Operator>
          <a:Value>${queryUserId}</a:Value>
        </a:Predicate>
      </Predicates>
      <Ordering i:nil="true" xmlns:a="https://bingads.microsoft.com/Customer/v13/Entities" />
      <PageInfo xmlns:a="https://bingads.microsoft.com/Customer/v13/Entities">
        <a:Index>0</a:Index>
        <a:Size>50</a:Size>
      </PageInfo>
    </SearchAccountsRequest>
  </s:Body>
</s:Envelope>`;
            const searchRes = await fetch(CUSTOMER_MANAGEMENT_API, {
              method: "POST",
              headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "SearchAccounts" },
              body: searchAccountsXml,
              signal: AbortSignal.timeout(20000),
            });
            const searchText = await searchRes.text();
            if (searchRes.ok && !searchText.includes("<s:Fault>")) {
              const cleanSearch = searchText.replace(
                /<[a-zA-Z0-9]*:?BusinessAddress>[\s\S]*?<\/[a-zA-Z0-9]*:?BusinessAddress>/gi,
                "",
              );
              const accountBlocks =
                cleanSearch.match(
                  /<[a-zA-Z0-9]*:?AdvertiserAccount[\s\S]*?<\/[a-zA-Z0-9]*:?AdvertiserAccount>/gi,
                ) || [];
              for (const block of accountBlocks) {
                const id = block.match(/<[a-zA-Z0-9]*:?Id>(\d+)<\/[a-zA-Z0-9]*:?Id>/i)?.[1];
                const accName = block.match(/<[a-zA-Z0-9]*:?Name>([^<]+)<\/[a-zA-Z0-9]*:?Name>/i)?.[1];
                const number = block.match(/<[a-zA-Z0-9]*:?Number>([^<]+)<\/[a-zA-Z0-9]*:?Number>/i)?.[1];
                const currency = block.match(
                  /<[a-zA-Z0-9]*:?CurrencyCode>([^<]+)<\/[a-zA-Z0-9]*:?CurrencyCode>/i,
                )?.[1];
                const parentCust =
                  block.match(
                    /<[a-zA-Z0-9]*:?ParentCustomerId>(\d+)<\/[a-zA-Z0-9]*:?ParentCustomerId>/i,
                  )?.[1] || customerId;
                if (id && !adAccounts.some((a) => a.id === id)) {
                  adAccounts.push({
                    id,
                    name: accName || `Account ${number || id}`,
                    number,
                    currency,
                    parentCustomerId: parentCust,
                  });
                }
              }
            }
          }

          if (!adAccounts.length) {
            try {
              const getAccountsInfoXml = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header xmlns="https://bingads.microsoft.com/Customer/v13">
    <Action mustUnderstand="1">GetAccountsInfo</Action>
    <AuthenticationToken>${realToken}</AuthenticationToken>
    <DeveloperToken>${devToken}</DeveloperToken>
  </s:Header>
  <s:Body>
    <GetAccountsInfoRequest xmlns="https://bingads.microsoft.com/Customer/v13">
      <CustomerId i:nil="true" />
      <OnlyParentAccounts>false</OnlyParentAccounts>
    </GetAccountsInfoRequest>
  </s:Body>
</s:Envelope>`;
              const infoRes = await fetch(CUSTOMER_MANAGEMENT_API, {
                method: "POST",
                headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "GetAccountsInfo" },
                body: getAccountsInfoXml,
                signal: AbortSignal.timeout(20000),
              });
              const infoText = await infoRes.text();
              if (infoRes.ok && !infoText.includes("<s:Fault>")) {
                const infoBlocks =
                  infoText.match(/<[a-zA-Z0-9]*:?AccountInfo[\s\S]*?<\/[a-zA-Z0-9]*:?AccountInfo>/gi) || [];
                for (const block of infoBlocks) {
                  const id = block.match(/<[a-zA-Z0-9]*:?Id>(\d+)<\/[a-zA-Z0-9]*:?Id>/i)?.[1];
                  const accName = block.match(/<[a-zA-Z0-9]*:?Name>([^<]+)<\/[a-zA-Z0-9]*:?Name>/i)?.[1];
                  const number = block.match(/<[a-zA-Z0-9]*:?Number>([^<]+)<\/[a-zA-Z0-9]*:?Number>/i)?.[1];
                  if (id && !adAccounts.some((a) => a.id === id)) {
                    adAccounts.push({
                      id,
                      name: accName || `Account ${number || id}`,
                      parentCustomerId: customerId,
                    });
                  }
                }
              }
            } catch {
              /* ignore */
            }
          }

          if (!adAccounts.length && customerId) {
            adAccounts.push({ id: customerId, name: `Customer ${customerId}`, parentCustomerId: customerId });
          }
        }
      } catch (e) {
        issues.push({
          code: "ads_accounts_unavailable",
          message: `Could not list Microsoft Advertising accounts: ${(e as Error).message}`,
        });
      }
    } else if (!devToken) {
      issues.push({
        code: "no_developer_token",
        message: "Microsoft Advertising developer token is not configured",
      });
    }

    if (!adAccounts.length) {
      issues.push({ code: "no_ad_account", message: "No Microsoft Advertising account found for this login" });
    }
    const selected = adAccounts[0] || null;
    return {
      externalAccountId: selected?.id || userId || "bing_ads",
      externalAccountName: selected ? `${selected.name} (${selected.id})` : name,
      currency: selected?.currency,
      meta: {
        userId,
        email,
        name,
        adAccounts,
        customers: adAccounts,
        selectedAdAccountId: selected?.id || null,
        parentCustomerId: selected?.parentCustomerId || null,
      },
      issues,
    };
  },
};

/* ---------------- OpenAI Ads (API key, no OAuth) ---------------- */
const openai_ads: Provider = {
  apiKey: true,
  account: async (cfg, t) => {
    const base =
      (cfg.extra?.adsApiBaseUrl as string) ||
      (cfg.extra?.apiBaseUrl as string) ||
      "https://api.ads.openai.com/v1";
    const d = await json(`${base}/ad_accounts`, { headers: { Authorization: `Bearer ${t.accessToken}` } }, "OpenAI Ads account");
    const a = (d.data || d.items || d.ad_accounts || [])[0] || (d.id ? d : null);
    if (!a) throw new Error("OpenAI Ads returned no ad account for this API key");
    return {
      externalAccountId: a.id,
      externalAccountName: a.name || a.id,
      currency: a.currency,
      meta: { adAccounts: [{ id: a.id, name: a.name || a.id }], selectedAdAccountId: a.id },
      issues: [],
    };
  },
};

/* ---------------- X (Twitter) Ads ---------------- */
const X_OAUTH_BASE = "https://api.twitter.com";
const X_API_BASE = "https://api.x.com/2";
const X_ADS_BASE = "https://ads-api.x.com/12";

export function isTwitterOAuth2(cfg: PlatformCfg): boolean {
  if (cfg.oauthVersion === 2 || cfg.oauthVersion === "2") return true;
  if (cfg.oauthVersion === 1 || cfg.oauthVersion === "1") return false;
  if (!cfg?.clientId) return false;
  if (cfg.clientId.includes(":")) return true;
  if (cfg.clientId.length > 28) return true;
  try {
    const decoded = b64decodeToString(cfg.clientId);
    if (decoded.includes(":") && !/[^\x20-\x7E]/.test(decoded)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function xPKCE(state: string, secret: string): Promise<{ verifier: string; challenge: string }> {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret || "reach-oauth2-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const verifierRaw = await crypto.subtle.sign("HMAC", key, te.encode("pkce:" + (state || "x-state")));
  const verifier = b64encode(new Uint8Array(verifierRaw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const challengeRaw = await crypto.subtle.digest("SHA-256", te.encode(verifier));
  const challenge = b64encode(new Uint8Array(challengeRaw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

export interface XRequestToken {
  authUrl: string;
  oauthToken: string;
  oauthTokenSecret: string;
}

/**
 * X OAuth 1.0a request-token dance. Returns the authorize URL plus the
 * token secret the callback needs — the route stashes the secret in D1
 * (oauth_request_tokens) since Workers have no shared in-memory Map.
 */
export async function xRequestToken(
  cfg: PlatformCfg,
  redirectUri: string,
  state: string,
): Promise<XRequestToken> {
  const candidateUris: string[] = [];
  if (redirectUri) candidateUris.push(redirectUri);
  if (redirectUri && redirectUri.startsWith("https://localhost:")) {
    candidateUris.push(redirectUri.replace("https://localhost:", "http://localhost:"));
  } else if (redirectUri && redirectUri.startsWith("http://localhost:")) {
    candidateUris.push(redirectUri.replace("http://localhost:", "https://localhost:"));
  }
  candidateUris.push(
    "http://localhost:3001/auth/x/callback",
    "https://app.adsrunner.eu/auth/x/callback",
  );
  const dedupedUris = [...new Set(candidateUris)];
  const url = `${X_OAUTH_BASE}/oauth/request_token`;
  let lastError: string | null = null;

  for (const testUri of dedupedUris) {
    const oauth = {
      consumerKey: cfg.clientId || "",
      consumerSecret: cfg.clientSecret || "",
      accessToken: "",
      accessTokenSecret: "",
    };
    const params = { oauth_callback: testUri };
    const authHeader = await generateOAuth1Header("POST", url, oauth, params);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      if (res.ok) {
        const parsed = new URLSearchParams(text);
        const oauthToken = parsed.get("oauth_token");
        const oauthTokenSecret = parsed.get("oauth_token_secret");
        if (oauthToken && oauthTokenSecret) {
          return {
            authUrl: `${X_OAUTH_BASE}/oauth/authorize?oauth_token=${oauthToken}`,
            oauthToken,
            oauthTokenSecret,
          };
        }
      } else {
        lastError = text;
        if (res.status === 403 || text.includes("415")) {
          console.warn(`[X OAuth] Twitter rejected redirect URI "${testUri}" (code 415); trying next candidate...`);
          continue;
        }
        throw new Error(`Failed to get X request token (HTTP ${res.status}): ${text}`);
      }
    } catch (err) {
      if ((err as Error).message.includes("HTTP")) throw err;
      lastError = (err as Error).message;
    }
  }
  throw new Error(`Failed to get X request token: ${lastError}`);
}

const x: Provider = {
  authUrl: async (cfg, redirectUri, state, env) => {
    const isOAuth2 = isTwitterOAuth2(cfg);
    if (isOAuth2) {
      const defaultScopes = ["tweet.read", "users.read", "offline.access"];
      const scopes = cfg.scopes?.length ? cfg.scopes : defaultScopes;
      const { challenge } = await xPKCE(state, env?.SECRET_KEY || "");
      return `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(
        cfg.clientId || "",
      )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(
        scopes.join(" "),
      )}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(
        challenge,
      )}&code_challenge_method=S256`;
    }

    // Default: OAuth 1.0a 3-legged flow (required for X Ads API v12)
    const rt = await xRequestToken(cfg, redirectUri, state);
    return rt.authUrl;
  },

  exchange: async (cfg, codeOrVerifier, redirectUri, verifierOrState, extra = {}) => {
    const oauthToken = extra.oauth_token || extra.oauthToken;
    const isOAuth1 = Boolean(oauthToken || extra.oauth_verifier || (!isTwitterOAuth2(cfg) && !extra.code));

    if (isOAuth1) {
      const token = oauthToken || extra.oauth_token;
      const tokenSecret = extra.oauthTokenSecret || "";
      const url = `${X_OAUTH_BASE}/oauth/access_token`;
      const oauth = {
        consumerKey: cfg.clientId || "",
        consumerSecret: cfg.clientSecret || "",
        accessToken: token || "",
        accessTokenSecret: tokenSecret,
      };
      const params = { oauth_verifier: codeOrVerifier };
      const authHeader = await generateOAuth1Header("POST", url, oauth, params);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Failed to exchange X OAuth verifier: ${text}`);
      }
      const parsed = new URLSearchParams(text);
      const accessToken = parsed.get("oauth_token") || "";
      const accessTokenSecret = parsed.get("oauth_token_secret") || "";
      const userId = parsed.get("user_id") || "";
      const screenName = parsed.get("screen_name") || "";
      return {
        accessToken,
        refreshToken: accessTokenSecret,
        expiresIn: null,
        meta: { accessTokenSecret, userId, screenName, oauthVersion: 1 },
      };
    }

    // OAuth 2.0 code exchange
    const state = verifierOrState || extra.state || "";
    const { verifier } = await xPKCE(state, (extra as any).pkceSecret || "");
    const d = await postForm(
      "https://api.twitter.com/2/oauth2/token",
      {
        client_id: cfg.clientId,
        grant_type: "authorization_code",
        code: codeOrVerifier,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      cfg.clientSecret ? basic(cfg.clientId || "", cfg.clientSecret) : {},
    );
    if (!d.access_token) {
      throw new Error(d.error_description || d.error || "Twitter did not return an access token");
    }
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresIn: d.expires_in,
      scopes: d.scope ? d.scope.split(" ") : [],
      meta: { oauthVersion: 2 },
    };
  },

  refresh: async (cfg, refreshToken) => {
    if (!refreshToken) throw new Error("No refresh token");
    if (refreshToken.length < 50 && !refreshToken.includes("-")) {
      return { accessToken: refreshToken, refreshToken, expiresIn: null };
    }
    const d = await postForm(
      "https://api.twitter.com/2/oauth2/token",
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId },
      cfg.clientSecret ? basic(cfg.clientId || "", cfg.clientSecret) : {},
    );
    if (!d.access_token) {
      throw new Error(d.error_description || d.error || "Twitter did not return an access token on refresh");
    }
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || refreshToken,
      expiresIn: d.expires_in,
      scopes: d.scope ? d.scope.split(" ") : [],
    };
  },

  account: async (cfg, tokens) => {
    const accessToken = tokens.accessToken;
    const isOAuth1 =
      tokens.meta?.oauthVersion === 1 || (!tokens.meta?.oauthVersion && !isTwitterOAuth2(cfg));
    const tokenSecret = isOAuth1 ? tokens.refreshToken || tokens.meta?.accessTokenSecret || "" : "";
    let me: Record<string, any> = {};
    const issues: AccountIssue[] = [];
    const adAccounts: Array<Record<string, any>> = [];

    try {
      if (isOAuth1 && tokenSecret) {
        const oauth = {
          consumerKey: cfg.clientId || "",
          consumerSecret: cfg.clientSecret || "",
          accessToken,
          accessTokenSecret: tokenSecret,
        };
        const res = await makeOAuth1Request("GET", `${X_API_BASE}/users/me`, oauth, {
          "user.fields": "id,name,username,profile_image_url",
        });
        me = res?.data || {};
      } else {
        const res = await json(
          `${X_API_BASE}/users/me?user.fields=id,name,username,profile_image_url`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        me = res?.data || {};
      }
    } catch (e) {
      console.warn("X get user profile failed:", (e as Error).message);
    }

    try {
      if (isOAuth1 && tokenSecret) {
        const oauth = {
          consumerKey: cfg.clientId || "",
          consumerSecret: cfg.clientSecret || "",
          accessToken,
          accessTokenSecret: tokenSecret,
        };
        const res = await makeOAuth1Request("GET", `${X_ADS_BASE}/accounts`, oauth, {});
        const list = (res?.data || []).filter((a: any) => !a.deleted);
        for (const a of list) {
          adAccounts.push({ id: a.id, name: a.name || a.id, currency: a.currency, timezone: a.timezone });
        }
      } else {
        const res = await json(`${X_ADS_BASE}/accounts`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const list = (res?.data || []).filter((a: any) => !a.deleted);
        for (const a of list) {
          adAccounts.push({ id: a.id, name: a.name || a.id, currency: a.currency, timezone: a.timezone });
        }
      }
    } catch (e) {
      issues.push({
        code: "ads_accounts_unavailable",
        message: `Could not list X Ads accounts: ${(e as Error).message}`,
      });
    }

    if (!adAccounts.length) {
      issues.push({
        code: "x_ads_account_optional",
        message: "No X Ads account discovered yet — specify in settings if managing ads",
      });
    }
    const selected = adAccounts[0] || null;
    return {
      externalAccountId: selected?.id || me.id || "x_ads",
      externalAccountName: selected ? `${selected.name} (${selected.id})` : me.username ? `@${me.username}` : "X Account",
      currency: selected?.currency,
      meta: {
        userId: me.id,
        username: me.username,
        name: me.name,
        profileImageUrl: me.profile_image_url,
        accessTokenSecret: tokenSecret,
        adAccounts,
        customers: adAccounts,
        selectedAdAccountId: selected?.id || null,
        oauthVersion: isOAuth1 ? 1 : 2,
      },
      issues,
    };
  },
};

export const PROVIDERS: Record<string, Provider> = {
  google_ads: google,
  meta,
  tiktok,
  reddit,
  pinterest,
  openai_ads,
  bing_ads: bing,
  bing,
  x,
  twitter: x,
};

export const providerFor = (code?: string | null): Provider | null =>
  (code && PROVIDERS[code]) || null;
