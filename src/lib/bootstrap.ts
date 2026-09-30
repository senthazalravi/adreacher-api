// Turns a tenant into a working account: default workspace (+ settings),
// owner membership, and a trial subscription.
// Port of the old lib/bootstrap.js, minus the Baasix-isms: tenant `name` is
// the display name directly (no synthetic-name + settings-title split needed).

import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/index.js";
import { tenants, users } from "../db/schema/identity.js";
import { workspaces, workspaceMembers } from "../db/schema/core.js";
import { workspaceSettings } from "../db/schema/ops.js";
import { subscriptionPlans, subscriptions } from "../db/schema/ops.js";

const rand = () => Math.random().toString(36).slice(2, 10);

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "account";
  return `${base}-${rand()}`;
}

export interface BootstrapInput {
  name?: string;
  type?: "client" | "agency";
  orgNumber?: string | null;
  billingEmail?: string | null;
  contactPerson?: string | null;
  country?: string | null;
  defaultCurrency?: string | null;
}

/**
 * Create (or complete) a tenant for `ownerUserId`. Returns the tenant and the
 * default workspace id (null for agencies, which get no workspace of their own).
 */
export async function bootstrapAccount(
  db: Db,
  input: { account?: BootstrapInput | null; ownerUserId?: string | null },
): Promise<{ tenantId: string; workspaceId: string | null }> {
  const wanted = input.account ?? {};
  const displayName = wanted.name?.trim() || "Untitled";

  // 1. tenant
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: displayName,
      slug: slugify(displayName),
      type: wanted.type === "agency" ? "agency" : "client",
      status: "active",
      ownerId: input.ownerUserId ?? null,
      orgNumber: wanted.orgNumber ?? null,
      billingEmail: wanted.billingEmail ?? null,
      contactPerson: wanted.contactPerson ?? null,
      country: wanted.country ?? null,
    })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("Tenant insert failed");
  const tenantId = tenant.id;
  const isAgency = wanted.type === "agency";

  // 2. default workspace (+ settings) — agencies get none of their own
  let workspaceId: string | null = null;
  if (!isAgency) {
    const [ws] = await db
      .insert(workspaces)
      .values({        name: displayName,
        account_id: tenantId,
        isDefault: true,
        currency: wanted.defaultCurrency || "SEK",
        onboardingState: "pending",
      })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error("Workspace insert failed");
    workspaceId = ws.id;
    await db.insert(workspaceSettings).values({ workspace_id: workspaceId, account_id: tenantId });
  }

  // 3. owner membership
  if (input.ownerUserId && workspaceId) {
    await db.insert(workspaceMembers).values({
      workspace_id: workspaceId,
      member_id: input.ownerUserId,
      account_id: tenantId,
      role: "owner",
      status: "active",
      acceptedAt: new Date(),
    });
    await db
      .update(users)
      .set({ tenantId, activeWorkspaceId: workspaceId, updatedAt: new Date() })
      .where(eq(users.id, input.ownerUserId));
  } else if (input.ownerUserId) {
    await db
      .update(users)
      .set({ tenantId, updatedAt: new Date() })
      .where(eq(users.id, input.ownerUserId));
  }

  // 4. trial subscription (skipped silently when no plans are seeded yet)
  const plan = await db.query.subscriptionPlans.findFirst({
    where: and(eq(subscriptionPlans.slug, isAgency ? "agency" : "basic")),
  });
  if (plan) {
    const trialDays = plan.trialDays ?? 14;
    const now = new Date();
    await db.insert(subscriptions).values({
      account_id: tenantId,
      plan_id: plan.id,
      status: "trialing",
      trialEndsAt: new Date(now.getTime() + trialDays * 864e5),
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + trialDays * 864e5),
    });
  }

  return { tenantId, workspaceId };
}
