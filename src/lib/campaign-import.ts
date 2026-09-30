// Import campaigns that already exist in an ad platform into Reach.
//
// Port of the old lib/campaign-import.js, backed by Drizzle/D1. Keeping its two
// hard-won behaviours:
//
//   1. A connected Google account is often a MANAGER (MCC), which holds no campaigns of its
//      own — they live in the client accounts beneath it. So a manager is expanded into its
//      children and each is queried with `login-customer-id` set to the manager.
//   2. Campaigns are matched on the external id, so re-running is idempotent: an existing row
//      has its status refreshed instead of being duplicated.
import { and, eq, inArray } from "drizzle-orm";
import { adPlatforms, campaignPlatforms, campaigns, platformConnections } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import { getConnectionConfig, getValidAccessToken } from "./connections.js";
import { googleAdsVersion } from "./platform-providers.js";

/** Google's own status → the campaign status Reach shows. Mirrors reach_be's mapping. */
export function mapGoogleStatus(primaryStatus: unknown, rawStatus: unknown): string {
  const ps = String(primaryStatus || "").toUpperCase().trim();
  const raw = String(rawStatus || "").toUpperCase().trim();
  // Primary status is Google's real-time serving state and wins when present.
  if (ps === "ENDED") return "completed";
  if (ps === "PAUSED") return "paused";
  if (ps === "REMOVED") return "archived";
  if (ps === "PENDING") return "draft";
  if (ps === "NOT_ELIGIBLE" || ps === "MISCONFIGURED") return "failed";
  if (ps === "ELIGIBLE" || ps === "LEARNING" || ps === "LIMITED") return "active";
  // Otherwise fall back to the status the advertiser configured.
  if (raw === "ENABLED") return "active";
  if (raw === "PAUSED") return "paused";
  if (raw === "REMOVED") return "archived";
  return "draft";
}

const digits = (v: unknown) => String(v || "").replace(/\D/g, "");

interface GaqlCtx {
  version: string;
  accessToken: string;
  developerToken: string;
  rootCustomerId: string;
  loginCustomerId?: string | null;
  customerId?: string;
}

async function gaql(ctx: GaqlCtx & { query: string; customerId?: string }): Promise<any[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    "developer-token": ctx.developerToken,
    "Content-Type": "application/json",
  };
  if (ctx.loginCustomerId) headers["login-customer-id"] = digits(ctx.loginCustomerId);
  const r = await fetch(
    `https://googleads.googleapis.com/${ctx.version}/customers/${digits(ctx.customerId || ctx.rootCustomerId)}/googleAds:searchStream`,
    { method: "POST", headers, body: JSON.stringify({ query: ctx.query }) },
  );
  const text = await r.text();
  if (!r.ok) {
    // A sunset API version answers with an HTML page rather than JSON; say so plainly
    // instead of surfacing a wall of markup.
    const detail = text.trim().startsWith("<") ? `Google Ads API ${ctx.version} is not available` : text.slice(0, 300);
    throw new HttpError(r.status, `Google Ads query failed (${r.status}): ${detail}`, "UPSTREAM_ERROR");
  }
  const chunks = JSON.parse(text || "[]");
  return (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c: any) => c?.results || []);
}

/** The accounts actually holding campaigns: a manager expands into its client accounts. */
async function resolveAdAccounts(ctx: GaqlCtx): Promise<{ id: string; name: string }[]> {
  const rows = await gaql({
    ...ctx,
    query: "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client WHERE customer_client.level <= 1",
  }).catch(() => []);
  const children = rows
    .map((r: any) => r.customerClient)
    .filter((c: any) => c && c.manager !== true && digits(c.id))
    .map((c: any) => ({ id: digits(c.id), name: c.descriptiveName || digits(c.id) }));
  // Not a manager (or the lookup failed): query the connected account directly.
  return children.length ? children : [{ id: digits(ctx.rootCustomerId), name: digits(ctx.rootCustomerId) }];
}

/**
 * Import Google Ads campaigns into one workspace.
 * Returns { imported, updated, skipped, accounts } — `skipped` counts campaigns already
 * present and unchanged.
 */
export async function importGoogleCampaigns(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  opts: { workspaceId: string; accountId: string; connection: Record<string, any>; uid?: string | null },
) {
  const { workspaceId, accountId, connection, uid } = opts;
  const { accessToken } = await getValidAccessToken(db, secretKey, workspaceId, "google_ads", env);
  const { config: cfg } = await getConnectionConfig(db, env, secretKey, workspaceId, "google_ads");
  if (!cfg?.developerToken) throw new HttpError(400, "Google Ads developer token is not configured", "BAD_REQUEST");

  // If the connected account is a client under an MCC, Google requires every API call
  // to include `login-customer-id` set to the manager account ID. For standalone accounts
  // the field is absent in meta, so we fall back to the account itself (no header needed).
  const managerCustomerId = connection.meta?.managerCustomerId || null;
  const ctx: GaqlCtx = {
    version: googleAdsVersion(cfg),
    accessToken,
    developerToken: cfg.developerToken,
    rootCustomerId: connection.externalAccountId,
    // loginCustomerId drives the login-customer-id header in gaql(); null = omit the header.
    loginCustomerId: managerCustomerId || connection.externalAccountId,
  };
  const accounts = await resolveAdAccounts(ctx);

  const platformRows = await db.select().from(adPlatforms).where(eq(adPlatforms.code, "google_ads")).limit(1);
  const platformId = (platformRows[0] as any)?.id ?? null;
  let imported = 0, updated = 0, skipped = 0;

  for (const account of accounts) {
    // BASE only: drafts and experiment arms would otherwise duplicate the real campaign.
    const rows = await gaql({
      ...ctx,
      customerId: account.id,
      query: `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.advertising_channel_type,
                     campaign_budget.amount_micros, campaign.start_date_time, campaign.end_date_time
              FROM campaign
              WHERE campaign.status != 'REMOVED' AND campaign.experiment_type = 'BASE'`,
    });

    for (const row of rows) {
      const c = row.campaign;
      if (!c?.id) continue;
      const externalId = String(c.id);
      const status = mapGoogleStatus(c.primaryStatus, c.status);
      // The channel type is what the builder keys everything on (creative shape, required
      // image slots, bidding defaults). Without it an imported campaign opened in the editor
      // had no type until the user visited the Reach stage, hiding the Google creative form.
      const campaignType = String(c.advertisingChannelType || "").toUpperCase() || null;
      const budget = row.campaignBudget?.amountMicros ? Number(row.campaignBudget.amountMicros) / 1e6 : null;

      // Check if this campaign has already been imported into THIS workspace
      const campsInWs = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.workspace_id, workspaceId)).limit(10000);
      const campIds = campsInWs.map((r: any) => r.id);

      const existing = campIds.length
        ? (
            await db
              .select()
              .from(campaignPlatforms)
              .where(and(eq(campaignPlatforms.externalCampaignId, externalId), inArray(campaignPlatforms.campaign_id, campIds)))
              .limit(1)
          )[0]
        : null;

      if (existing) {
        const existingTyped = existing as unknown as Record<string, any>;
        const patch: Record<string, any> = {};
        if (existingTyped.status !== status) patch.status = status;
        if (campaignType && existingTyped.campaignType !== campaignType) {
          patch.campaignType = campaignType;
          patch.payload = { ...(existingTyped.payload || {}), targeting: { ...(existingTyped.payload?.targeting || {}), campaignType } };
        }
        if (Object.keys(patch).length) {
          await db
            .update(campaignPlatforms)
            .set({ ...patch, connection_id: connection.id, lastSyncedAt: new Date(), updatedAt: new Date() })
            .where(eq(campaignPlatforms.id, existingTyped.id));
          if (patch.status) {
            await db
              .update(campaigns)
              .set({ status: status as any, updatedAt: new Date() })
              .where(eq(campaigns.id, existingTyped.campaign_id))
              .catch(() => {});
          }
          updated += 1;
        } else skipped += 1;
        continue;
      }

      const inserted = await db
        .insert(campaigns)
        .values({
          workspace_id: workspaceId,
          account_id: accountId,
          name: c.name || "Untitled campaign",
          objective: "local_visits",
          status: status as any,
          budgetType: "daily",
          budgetAmount: budget,
          currency: connection.currency || "SEK",
          // v23 exposes these as *_date_time; the column is a plain date, so trim the time part.
          startDate: (c.startDateTime || "").slice(0, 10) ? new Date((c.startDateTime || "").slice(0, 10)) : null,
          endDate: (c.endDateTime || "").slice(0, 10) ? new Date((c.endDateTime || "").slice(0, 10)) : null,
          // Old backend used builderStage "review"; the new schema's final stage is "launch".
          // Imported campaigns are already live on the platform, so they land at the end.
          builderStage: "launch",
          createdBy_id: uid || null,
          // Marks the row as mirrored from the platform rather than authored in Reach.
          tracking: { importedFrom: "google_ads", externalAccountId: account.id, externalAccountName: account.name },
          source: "import",
        })
        .returning({ id: campaigns.id });

      await db
        .insert(campaignPlatforms)
        .values({
          campaign_id: inserted[0]!.id,
          platform_id: platformId,
          account_id: accountId,
          connection_id: connection.id,
          status: status as any,
          externalCampaignId: externalId,
          budgetAmount: budget,
          campaignType,
          lastSyncedAt: new Date(),
          publishedAt: new Date(),
          // `payload.targeting.campaignType` is where the edit page and publisher read the type.
          payload: { importedAccountId: account.id, ...(campaignType ? { targeting: { campaignType } } : {}) },
        })
        .catch(() => {});
      imported += 1;
    }
  }

  await db
    .update(platformConnections)
    .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(platformConnections.id, connection.id))
    .catch(() => {});
  return { imported, updated, skipped, accounts: accounts.map((a) => a.id) };
}
