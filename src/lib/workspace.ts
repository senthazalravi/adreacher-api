// Workspace bootstrap: creating a workspace also creates its
// workspace_settings row and adds the creator as an owner member.
// Port of the old client-workspaces / account-bootstrap hooks.
import { eq } from "drizzle-orm";
import { workspaces, workspaceMembers, workspaceSettings } from "../db/schema/index.js";
import { assertPlanAllows } from "./limits.js";
import type { Db } from "../db/index.js";

export interface BootstrapInput {
  accountId: string;
  userId: string;
  name: string;
  slug?: string;
  /** Extra workspace columns to set on the row (e.g. timezone, currency). */
  extra?: Record<string, unknown>;
}

/**
 * Create a workspace with settings + owner membership, enforcing the plan
 * limit on workspace count first. Returns the raw workspace row.
 */
export async function bootstrapWorkspace(db: Db, input: BootstrapInput) {
  await assertPlanAllows(db, "workspaces", input.accountId);

  const wsRows = await db
    .insert(workspaces)
    .values({
      name: input.name,
      slug: input.slug ?? null,
      account_id: input.accountId,
      ...(input.extra || {}),
    })
    .returning();
  const ws = wsRows[0] as unknown as Record<string, any>;

  await db.insert(workspaceSettings).values({
    workspace_id: ws.id,
    account_id: input.accountId,
  });

  await db.insert(workspaceMembers).values({
    workspace_id: ws.id,
    member_id: input.userId,
    account_id: input.accountId,
    role: "owner",
    status: "active",
    acceptedAt: new Date(),
  });

  return ws;
}

/** Ensure a workspace has a settings row (idempotent; for older rows). */
export async function ensureWorkspaceSettings(db: Db, workspaceId: string, accountId: string) {
  const rows = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspace_id, workspaceId));
  if (rows.length) return rows[0];
  const ins = await db
    .insert(workspaceSettings)
    .values({ workspace_id: workspaceId, account_id: accountId })
    .returning();
  return ins[0];
}
