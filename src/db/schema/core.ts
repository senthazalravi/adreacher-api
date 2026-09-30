import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug"),
    websiteUrl: text("websiteUrl"),
    industry: text("industry"),
    descriptor: text("descriptor"),
    timezone: text("timezone").notNull().default("Europe/Stockholm"),
    currency: text("currency").notNull().default("SEK"),
    locale: text("locale").notNull().default("en"),
    logo_Id: text("logo_Id"),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    onboardingState: text("onboardingState", { enum: ["pending", "brand_ready", "platform_connected", "creative_reviewed", "completed"] }).notNull().default("pending"),
    onboardingCompletedAt: integer("onboardingCompletedAt", { mode: "timestamp" }),
    isDefault: integer("isDefault", { mode: "boolean" }).notNull().default(false),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deletedAt", { mode: "timestamp" }),
  },
);

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    role: text("role", { enum: ["owner", "admin", "editor", "approver", "viewer"] }).notNull().default("editor"),
    invitedAt: integer("invitedAt", { mode: "timestamp" }),
    acceptedAt: integer("acceptedAt", { mode: "timestamp" }),
    status: text("status", { enum: ["invited", "active", "revoked"] }).notNull().default("active"),
    workspace_id: text("workspace_id"),
    member_id: text("member_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_id_member_id_ux").on(t.workspace_id, t.member_id),
  ],
);

export const agencyClients = sqliteTable(
  "agency_clients",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    status: text("status", { enum: ["active", "paused", "ended"] }).notNull().default("active"),
    engagementStartedAt: integer("engagementStartedAt", { mode: "timestamp" }),
    engagementEndedAt: integer("engagementEndedAt", { mode: "timestamp" }),
    notes: text("notes"),
    agency_id: text("agency_id"),
    client_id: text("client_id"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: integer("deletedAt", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("agency_clients_agency_id_client_id_ux").on(t.agency_id, t.client_id),
  ],
);

export const agencyStaffWorkspaces = sqliteTable(
  "agency_staff_workspaces",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    role: text("role", { enum: ["lead", "editor", "approver", "viewer"] }).notNull().default("editor"),
    assignedAt: integer("assignedAt", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    agency_id: text("agency_id"),
    staff_id: text("staff_id"),
    workspace_id: text("workspace_id"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("agency_staff_workspaces_agency_id_staff_id_workspace_id_ux").on(t.agency_id, t.staff_id, t.workspace_id),
  ],
);
