import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
export const userProfiles = sqliteTable(
  "user_profiles",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    preferredLanguage: text("preferredLanguage").notNull().default("en"),
    timezone: text("timezone"),
    address: text("address", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    consents: text("consents", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    lastActiveAccount_Id: text("lastActiveAccount_Id"),
    lastActiveWorkspace_Id: text("lastActiveWorkspace_Id"),
    uiPreferences: text("uiPreferences", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    onboardingChecklist: text("onboardingChecklist", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    owner_id: text("owner_id"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("user_profiles_owner_id_ux").on(t.owner_id),
  ],
);

export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    inAppEnabled: integer("inAppEnabled", { mode: "boolean" }).notNull().default(true),
    toastEnabled: integer("toastEnabled", { mode: "boolean" }).notNull().default(true),
    emailEnabled: integer("emailEnabled", { mode: "boolean" }).notNull().default(true),
    categories: text("categories", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    digestFrequency: text("digestFrequency", { enum: ["instant", "daily", "weekly", "off"] }).notNull().default("instant"),
    recipient_id: text("recipient_id"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("notification_preferences_recipient_id_ux").on(t.recipient_id),
  ],
);

export const subscriptionPlans = sqliteTable(
  "subscription_plans",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    audience: text("audience", { enum: ["client", "agency", "both"] }).notNull().default("client"),
    price: real("price").notNull().default(0),
    currency: text("currency").notNull().default("SEK"),
    billingInterval: text("billingInterval", { enum: ["month", "year"] }).notNull().default("month"),
    trialDays: integer("trialDays").notNull().default(14),
    stripeProductId: text("stripeProductId"),
    stripePriceId: text("stripePriceId"),
    entitlements: text("entitlements", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    isActive: integer("isActive", { mode: "boolean" }).notNull().default(true),
    displayOrder: integer("displayOrder").notNull().default(0),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("subscription_plans_slug_ux").on(t.slug),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    status: text("status", { enum: ["trialing", "active", "past_due", "canceled", "incomplete", "paused"] }).notNull().default("trialing"),
    stripeCustomerId: text("stripeCustomerId"),
    stripeSubscriptionId: text("stripeSubscriptionId"),
    trialEndsAt: integer("trialEndsAt", { mode: "timestamp" }),
    currentPeriodStart: integer("currentPeriodStart", { mode: "timestamp" }),
    currentPeriodEnd: integer("currentPeriodEnd", { mode: "timestamp" }),
    cancelAtPeriodEnd: integer("cancelAtPeriodEnd", { mode: "boolean" }).notNull().default(false),
    canceledAt: integer("canceledAt", { mode: "timestamp" }),
    entitlementOverrides: text("entitlementOverrides", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    plan_id: text("plan_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const usageCounters = sqliteTable(
  "usage_counters",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    metricKey: text("metricKey").notNull(),
    periodStart: integer("periodStart", { mode: "timestamp" }).notNull(),
    periodEnd: integer("periodEnd", { mode: "timestamp" }).notNull(),
    count: integer("count").notNull().default(0),
    limitValue: integer("limitValue"),
    workspace_id: text("workspace_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const workspaceSettings = sqliteTable(
  "workspace_settings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    autoLoopEnabled: integer("autoLoopEnabled", { mode: "boolean" }).notNull().default(false),
    loopIntervalDays: integer("loopIntervalDays").notNull().default(3),
    minImpressionsToCompare: integer("minImpressionsToCompare").notNull().default(1000),
    comparisonWeights: text("comparisonWeights", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{"ctr":0.7,"impressions":0.3}'`),
    maxBudget: real("maxBudget"),
    requireCreativeApproval: integer("requireCreativeApproval", { mode: "boolean" }).notNull().default(true),
    requireLandingApproval: integer("requireLandingApproval", { mode: "boolean" }).notNull().default(false),
    defaultIncludeGoogleTag: integer("defaultIncludeGoogleTag", { mode: "boolean" }).notNull().default(true),
    defaultIncludeFacebookPixel: integer("defaultIncludeFacebookPixel", { mode: "boolean" }).notNull().default(true),
    avgOrderValue: real("avgOrderValue"),
    extra: text("extra", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    workspace_id: text("workspace_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("workspace_settings_workspace_id_ux").on(t.workspace_id),
  ],
);

export const dashboardMetricPrefs = sqliteTable(
  "dashboard_metric_prefs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    platformCode: text("platformCode").notNull().default("all"),
    metricKeys: text("metricKeys", { mode: "json" }).$type<any[]>().notNull().default(sql`[]`),
    owner_id: text("owner_id"),
    workspace_id: text("workspace_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("dashboard_metric_prefs_owner_id_workspace_id_platformCode_ux").on(t.owner_id, t.workspace_id, t.platformCode),
  ],
);

export const deletionRequests = sqliteTable(
  "deletion_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    scope: text("scope", { enum: ["user", "workspace", "account"] }).notNull().default("account"),
    targetId: text("targetId").notNull(),
    status: text("status", { enum: ["pending", "scheduled", "completed", "cancelled"] }).notNull().default("pending"),
    requestedAt: integer("requestedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    scheduledDeletionDate: integer("scheduledDeletionDate", { mode: "timestamp" }),
    completedAt: integer("completedAt", { mode: "timestamp" }),
    notes: text("notes"),
    requestedBy_id: text("requestedBy_id"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const billingSettings = sqliteTable(
  "billing_settings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    stripePublishableKey: text("stripePublishableKey"),
    stripeSecretKey: text("stripeSecretKey"),
    stripeWebhookSecret: text("stripeWebhookSecret"),
    defaultCurrency: text("defaultCurrency").notNull().default("SEK"),
    trialDays: integer("trialDays").notNull().default(14),
    testMode: integer("testMode", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const aiSettings = sqliteTable(
  "ai_settings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    textProvider: text("textProvider").notNull().default("gemini"),
    textModel: text("textModel").notNull().default("gemini-2.5-flash"),
    textApiKey: text("textApiKey"),
    textBaseUrl: text("textBaseUrl"),
    fallbackModel: text("fallbackModel"),
    imageProvider: text("imageProvider").notNull().default("fal"),
    imageModel: text("imageModel"),
    imageApiKey: text("imageApiKey"),
    keyOverridden: integer("keyOverridden", { mode: "boolean" }).notNull().default(false),
    modelOverridden: integer("modelOverridden", { mode: "boolean" }).notNull().default(false),
    lastTest: text("lastTest", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);
