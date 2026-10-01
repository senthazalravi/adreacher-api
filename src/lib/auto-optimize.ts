// Auto-optimise loop — periodically build an improved variant of a live campaign, launch it,
// and keep whichever version performs best.
//
// Ported from reach_be's CampaignAutomationService. The scoring rule is its, verbatim in intent:
// CTR carries most of the weight, impressions a logarithmic minority, so a campaign with a
// freakishly high CTR on 12 impressions cannot beat a steady performer on 40 000.
//
// Settings, scoring, and metrics are non-AI and fully working here. The iteration itself
// (AI copy improvement + AI creative generation) arrives in Phase 5.
import { and, eq, isNull, lte } from "drizzle-orm";
import { campaignAnalytics, workspaceSettings } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";

const DEFAULTS = {
  loopIntervalDays: 7,
  minImpressionsToCompare: 1000,
  comparisonWeights: { ctr: 0.7, impressions: 0.3 },
};

/** Workspace automation settings, falling back to the same defaults reach_be used. */
export async function loopSettings(db: Db, workspaceId: string) {
  const rows = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspace_id, workspaceId)).limit(1);
  const row = (rows[0] as unknown as Record<string, any> | undefined) || {};
  return {
    autoLoopEnabled: row.autoLoopEnabled ?? false,
    loopIntervalDays: Number(row.loopIntervalDays) || DEFAULTS.loopIntervalDays,
    minImpressionsToCompare: Number(row.minImpressionsToCompare) || DEFAULTS.minImpressionsToCompare,
    comparisonWeights: { ...DEFAULTS.comparisonWeights, ...(row.comparisonWeights || {}) },
    maxBudget: row.maxBudget != null ? Number(row.maxBudget) : null,
  };
}

/**
 * CTR is the signal; impressions only earn a logarithmic bonus for reach. Without the log a
 * campaign could win purely by being shown more, which is a budget decision, not a better ad.
 */
export function computeScore(
  { ctr = 0, impressions = 0 }: { ctr?: number; impressions?: number },
  weights = DEFAULTS.comparisonWeights,
) {
  return Number(ctr) * (weights.ctr ?? 0.7) + Math.log10(Math.max(Number(impressions) || 0, 1) + 1) * 10 * (weights.impressions ?? 0.3);
}

/** Lifetime totals for a campaign, straight from the analytics rows the sync writes. */
export async function campaignMetrics(db: Db, campaignId: string) {
  const rows = await db
    .select()
    .from(campaignAnalytics)
    .where(and(eq(campaignAnalytics.campaign_id, campaignId), isNull(campaignAnalytics.hour)))
    .limit(1000);
  const sum = (k: "impressions" | "clicks" | "spend" | "conversions") =>
    rows.reduce((n, r: any) => n + Number(r[k] || 0), 0);
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  return {
    impressions,
    clicks,
    spend: sum("spend"),
    conversions: sum("conversions"),
    ctr: impressions ? (clicks / impressions) * 100 : 0,
  };
}

/**
 * Run one optimisation iteration on a campaign: AI-improved copy + new creatives,
 * launched alongside the current version. AI-driven — Phase 5.
 */
export async function runIteration(
  _db: Db,
  _env: Record<string, string | undefined>,
  _campaignId: string,
  _opts: { trigger?: string; uid?: string | null } = {},
): Promise<never> {
  throw new HttpError(501, "Auto-optimise iterations arrive in Phase 5", "NOT_IMPLEMENTED");
}

/** Run every workspace's due optimisation loops. Port of the old runDueLoops:
 *  every campaign with autoOptimize on whose next run is due gets one
 *  runIteration; per-campaign failures are collected, not thrown. */
export async function runDueLoops(
  db: Db,
  env: Record<string, string | undefined>,
): Promise<{ processed: number; errors: string[] }> {
  const { campaigns } = await import("../db/schema/index.js");
  const due = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.autoOptimize, true),
        lte(campaigns.nextOptimizationAt, new Date()),
        isNull(campaigns.deletedAt),
      ),
    )
    .limit(50);
  const errors: string[] = [];
  for (const c of due) {
    try {
      await runIteration(db, env, c.id, { trigger: "scheduled" });
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error)?.message || String(e)}`);
    }
  }
  return { processed: due.length, errors };
}
