// Notifications — port of the old lib/notify.js, backed by the `notifications`
// table instead of Baasix's built-in collection.
//
// Mapping onto the table's flat shape:
//   type    <- eventType   (free-form; the frontend translates from it)
//   title   <- English fallback title
//   body    <- English fallback body (falls back to the title; never empty)
//   data    <- { category, severity, entityType, entityId, actionLabel,
//                actionUrl, workspaceId, ...metadata }
//   seenAt  <- read state (no separate dismiss; dismissing deletes the row)
import { and, eq } from "drizzle-orm";
import { notifications } from "../db/schema/index.js";
import type { Db } from "../db/index.js";

export interface NotifyInput {
  /** e.g. "campaign.published", "platform.token.expired" */
  eventType: string;
  category?: string;
  severity?: "info" | "success" | "attention" | "error";
  title: string;
  body?: string;
  /** Extra string variables interpolated by the frontend's message keys. */
  metadata?: Record<string, string>;
  entityType?: string | null;
  entityId?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
  workspaceId?: string | null;
  accountId?: string | null;
}

/**
 * Write one notification row per recipient. Returns the created ids.
 * Never throws — a failed notification must not break the caller.
 */
export async function notify(
  db: Db,
  userIds: string[] | string,
  n: NotifyInput,
): Promise<string[]> {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return [];
  const data: Record<string, any> = {
    category: n.category ?? null,
    severity: n.severity || "info",
    entityType: n.entityType ?? null,
    entityId: n.entityId ?? null,
    actionLabel: n.actionLabel ?? null,
    actionUrl: n.actionUrl ?? null,
    workspaceId: n.workspaceId ?? null,
    ...(n.metadata || {}),
  };
  const created: string[] = [];
  for (const userId of ids) {
    try {
      const [row] = await db
        .insert(notifications)
        .values({
          tenantId: n.accountId ?? null,
          userId,
          type: n.eventType,
          title: n.title,
          body: n.body || n.title,
          data,
        })
        .returning({ id: notifications.id });
      if (row?.id) created.push(row.id);
    } catch (e) {
      console.warn("[notify] failed to write notification:", (e as Error)?.message);
    }
  }
  return created;
}

/** Fire-and-forget variant used by background jobs. */
export async function queueNotification(
  db: Db,
  userIds: string[] | string,
  n: NotifyInput,
): Promise<void> {
  await notify(db, userIds, n);
}
