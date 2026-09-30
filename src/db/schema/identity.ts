import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Rebuilt framework tables replacing the Baasix built-ins
// (baasix_User, baasix_Tenant, baasix_Account, baasix_AuditLog, baasix_File, invites).

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("passwordHash"),
  firstName: text("firstName"),
  lastName: text("lastName"),
  tenantId: text("tenantId"),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deletedAt", { mode: "timestamp" }),
});

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull().default("active"),
  planSlug: text("planSlug"),
  billingEmail: text("billingEmail"),
  contactPerson: text("contactPerson"),
  phones: text("phones", { mode: "json" }).$type<Record<string, any>>(),
  address: text("address", { mode: "json" }).$type<Record<string, any>>(),
  country: text("country"),
  orgNumber: text("orgNumber"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: integer("deletedAt", { mode: "timestamp" }),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull(),
  tenantId: text("tenantId").notNull(),
  role: text("role").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  acceptedAt: integer("acceptedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenantId"),
  userId: text("userId"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  data: text("data", { mode: "json" }).$type<Record<string, any>>(),
  seenAt: integer("seenAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenantId"),
  userId: text("userId"),
  action: text("action").notNull(),
  entityType: text("entityType"),
  entityId: text("entityId"),
  meta: text("meta", { mode: "json" }).$type<Record<string, any>>(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenantId"),
  r2Key: text("r2Key").notNull().unique(),
  filename: text("filename").notNull(),
  mimeType: text("mimeType"),
  sizeBytes: integer("sizeBytes").notNull().default(0),
  title: text("title"),
  isPublic: integer("isPublic", { mode: "boolean" }).notNull().default(false),
  folder: text("folder"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
