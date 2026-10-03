// Hourly: refresh tokens that are about to expire, flip statuses
// (healthy → expiring → expired) and notify owners.
// Port of extensions/baasix-schedule-connection-health.
import { and, eq, inArray } from "drizzle-orm";
import { adPlatforms, platformConnections, workspaceMembers } from "../db/schema/index.js";
import { computeStatus, getValidAccessToken } from "../lib/connections.js";
import { queueNotification } from "../lib/notify.js";
import { pausedAccountIds, type JobCtx } from "./index.js";

const REFRESH_WITHIN_MS = 3 * 864e5; // refresh tokens expiring in <3 days

export async function runConnectionHealth(ctx: JobCtx): Promise<Record<string, any>> {
  const { db } = ctx;
  const paused = await pausedAccountIds(db);
  const rows = await db
    .select({
      conn: platformConnections,
      platformCode: adPlatforms.code,
      platformName: adPlatforms.name,
    })
    .from(platformConnections)
    .leftJoin(adPlatforms, eq(platformConnections.platform_id, adPlatforms.id))
    .where(inArray(platformConnections.status, ["healthy", "expiring", "setup_incomplete"]))
    .limit(1000);

  let checked = 0;
  let refreshed = 0;
  let flipped = 0;
  let notified = 0;
  for (const { conn, platformCode, platformName } of rows) {
    if (!conn.workspace_id || paused.has(conn.account_id)) continue;
    checked++;
    try {
      const msLeft = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() - Date.now() : Infinity;
      if (conn.refreshToken && msLeft < REFRESH_WITHIN_MS && platformCode) {
        await getValidAccessToken(db, ctx.secretKey, conn.workspace_id, platformCode, ctx.env);
        refreshed++;
        continue;
      }
      const status = computeStatus(conn as unknown as Record<string, any>);
      if (status !== conn.status) {
        flipped++;
        await db
          .update(platformConnections)
          .set({ status: status as any, updatedAt: new Date() })
          .where(eq(platformConnections.id, conn.id));
        if (status === "expiring" || status === "expired") {
          const owners = await db
            .select({ memberId: workspaceMembers.member_id })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspace_id, conn.workspace_id),
                inArray(workspaceMembers.role, ["owner", "admin"]),
                eq(workspaceMembers.status, "active"),
              ),
            )
            .limit(20);
          const days = Math.max(0, Math.round(msLeft / 864e5));
          await queueNotification(
            db,
            owners.map((o) => o.memberId).filter(Boolean) as string[],
            {
              eventType: `platform.token.${status}`,
              category: "platform",
              severity: status === "expired" ? "error" : "attention",
              title:
                status === "expired"
                  ? `${platformName || platformCode} token expired`
                  : `${platformName || platformCode} token expires in ${days} day${days === 1 ? "" : "s"}`,
              body: "Campaigns keep running, but analytics sync will stop.",
              metadata: { platformName: platformName ?? "", daysLeft: String(days) },
              entityType: "platform_connection",
              entityId: conn.id,
              actionLabel: "Reconnect",
              actionUrl: "/dashboard/connections",
              workspaceId: conn.workspace_id,
              accountId: conn.account_id,
            },
          );
          notified++;
        }
      }
    } catch (e) {
      const message = (e as Error)?.message || String(e);
      await db
        .update(platformConnections)
        .set({
          lastError: message,
          status: /invalid_grant|revoked|expired/i.test(message) ? "expired" : conn.status,
          updatedAt: new Date(),
        })
        .where(eq(platformConnections.id, conn.id))
        .catch(() => {});
    }
  }
  return { checked, refreshed, flipped, notified };
}
