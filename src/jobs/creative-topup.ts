// Nightly (02:10 UTC): "generated overnight" — top the Approve queue up for
// workspaces that use AI creatives. A workspace qualifies when it generated a
// creative in the last 30 days and workspace_settings.extra.nightlyCreatives
// !== false. Plan limits are respected via checkAndIncrement (402 → skipped).
// Port of extensions/baasix-schedule-creative-topup.
import { and, eq, gte, inArray } from "drizzle-orm";
import { creatives, workspaces, workspaceSettings } from "../db/schema/index.js";
import { active, brandFor, startBatch } from "../lib/creatives.js";
import { checkAndIncrement } from "../lib/usage.js";
import { pausedAccountIds, type JobCtx } from "./index.js";

const TARGET = 6; // top the Approve queue up to this many pending
const MIN_PENDING = 3; // already enough open → skip
const DAYS = 30; // workspace used AI creatives within this window

export async function runCreativeTopup(
  ctx: JobCtx,
  opts: { target?: number; minPending?: number; days?: number } = {},
): Promise<Record<string, any>> {
  const { target = TARGET, minPending = MIN_PENDING, days = DAYS } = opts;
  const { db } = ctx;
  const since = new Date(Date.now() - days * 864e5);
  const paused = await pausedAccountIds(db);

  const recent = await db
    .select({ workspaceId: creatives.workspace_id })
    .from(creatives)
    .where(and(eq(creatives.isAiGenerated, true), gte(creatives.createdAt, since)))
    .limit(5000);

  const out = { workspaces: 0, generated: 0, skipped: 0, errors: 0 };
  for (const wsId of [...new Set(recent.map((r) => r.workspaceId).filter(Boolean) as string[])]) {
    try {
      const settings = (
        await db
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspace_id, wsId))
          .limit(1)
      )[0] as unknown as Record<string, any> | undefined;
      if ((settings?.extra as any)?.nightlyCreatives === false || active.has(wsId)) {
        out.skipped++;
        continue;
      }
      const open =
        (
          await db
            .select({ id: creatives.id })
            .from(creatives)
            .where(
              and(
                eq(creatives.workspace_id, wsId),
                inArray(creatives.status, ["pending", "redo_requested", "generating"]),
              ),
            )
            .limit(1000)
        ).length || 0;
      if (open >= minPending) {
        out.skipped++;
        continue;
      }
      const ws = (
        await db.select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1)
      )[0] as unknown as { id: string; account_id: string } | undefined;
      if (!ws || paused.has(ws.account_id)) {
        out.skipped++;
        continue;
      }
      const brand = await brandFor(db, wsId);
      if (!brand.sourceUrl && brand.name === "Your Brand") {
        out.skipped++;
        continue;
      }
      const n = target - open;
      try {
        await checkAndIncrement(db, {
          accountId: ws.account_id,
          workspaceId: ws.id,
          metricKey: "ai_generations",
          n,
        });
      } catch (e) {
        if ((e as any)?.status === 402) {
          out.skipped++;
          continue; // plan limit — skip quietly, the 402 UX is handled elsewhere
        }
        throw e;
      }
      out.workspaces++;
      const { done } = await startBatch(db, ctx.r2, ctx.env, {
        ws: { id: ws.id, accountId: ws.account_id },
        uid: null,
        brand,
        count: n,
        campaign: null,
        source: "nightly",
        wait: true,
      });
      await done;
      out.generated += n;
    } catch (e) {
      out.errors++;
      console.error(`[creative-topup] workspace ${wsId} failed:`, (e as Error)?.message || e);
    }
  }
  return out;
}
