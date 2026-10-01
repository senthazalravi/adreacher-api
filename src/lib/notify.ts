// Notification queue stub (Phase 7).
//
// The full notification system (DB-backed notifications table, delivery,
// preferences) arrives in Phase 8. Until then, jobs that want to notify
// workspace owners call queueNotification(), which logs the intent so the
// call sites are already in place and nothing is silently dropped.
export interface QueuedNotification {
  eventType: string;
  category?: string;
  severity?: "info" | "success" | "attention" | "error";
  title: string;
  body?: string;
  metadata?: Record<string, string>;
  entityType?: string | null;
  entityId?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
  workspaceId?: string | null;
  accountId?: string | null;
}

export async function queueNotification(
  userIds: string[] | string,
  n: QueuedNotification,
): Promise<void> {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return;
  // Phase 8: persist to the notifications table + deliver. For now, log.
  console.info(`[notify:stub] event=${n.eventType} users=${ids.length} title=${n.title}`);
}
