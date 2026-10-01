// Every 6 hours: pull insights for every campaign that has something on a
// platform. Port of extensions/baasix-schedule-analytics-sync.
import { and, inArray, isNotNull } from "drizzle-orm";
import { campaignPlatforms } from "../db/schema/index.js";
import { syncCampaignAnalytics } from "../lib/campaign-publisher.js";
import { pausedAccountIds, type JobCtx } from "./index.js";

export async function runAnalyticsSync(ctx: JobCtx): Promise<Record<string, any>> {
  const rows = await ctx.db
    .select({ campaignId: campaignPlatforms.campaign_id, accountId: campaignPlatforms.account_id })
    .from(campaignPlatforms)
    .where(
      and(
        isNotNull(campaignPlatforms.externalCampaignId),
        inArray(campaignPlatforms.status, ["live", "paused", "publishing", "failed"]),
      ),
    )
    .limit(1000);
  // Do not sync (or spend) on behalf of a paused account.
  const paused = await pausedAccountIds(ctx.db);
  const ids = [
    ...new Set(
      rows.filter((r) => r.campaignId && !paused.has(r.accountId)).map((r) => r.campaignId as string),
    ),
  ];
  let synced = 0;
  let errors = 0;
  for (const id of ids) {
    try {
      const r = await syncCampaignAnalytics(ctx.db, ctx.env, ctx.secretKey, id, { days: 7 });
      synced += r.synced;
      errors += r.errors;
    } catch {
      errors++;
    }
  }
  return { campaigns: ids.length, synced, errors };
}
