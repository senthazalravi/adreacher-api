import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
export const brandProfiles = sqliteTable(
  "brand_profiles",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    sourceUrl: text("sourceUrl"),
    business: text("business", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    branding: text("branding", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    toneOfVoice: text("toneOfVoice", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
    audience: text("audience", { mode: "json" }).$type<Record<string, any>>().default(sql`'{}'`),
    keywords: text("keywords", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
    suggestedCampaigns: text("suggestedCampaigns", { mode: "json" }).$type<any[]>().default(sql`'[]'`),
    scrapeStatus: text("scrapeStatus", { enum: ["pending", "fetching", "reading", "extracting", "drafting", "ready", "failed"] }).notNull().default("pending"),
    scrapeError: text("scrapeError"),
    lastScrapedAt: integer("lastScrapedAt", { mode: "timestamp" }),
    onboardingCompletedAt: integer("onboardingCompletedAt", { mode: "timestamp" }),
    workspace_id: text("workspace_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
);

export const brandScrapeDrafts = sqliteTable(
  "brand_scrape_drafts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    token: text("token").notNull().unique(),
    sourceUrl: text("sourceUrl").notNull(),
    status: text("status", { enum: ["pending", "fetching", "reading", "extracting", "drafting", "ready", "failed"] }).notNull().default("pending"),
    steps: text("steps", { mode: "json" }).$type<any[]>().notNull().default(sql`'[]'`),
    result: text("result", { mode: "json" }).$type<Record<string, any>>().default(sql`'{}'`),
    error: text("error"),
    claimedByWorkspace_Id: text("claimedByWorkspace_Id"),
    claimedAt: integer("claimedAt", { mode: "timestamp" }),
    expiresAt: integer("expiresAt", { mode: "timestamp" }),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("brand_scrape_drafts_token_ux").on(t.token),
  ],
);

export const adPlatforms = sqliteTable(
  "ad_platforms",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["ads", "social", "both"] }).notNull().default("ads"),
    isEnabled: integer("isEnabled", { mode: "boolean" }).notNull().default(true),
    unlocksCopy: text("unlocksCopy"),
    supportedObjectives: text("supportedObjectives", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    budgetMinimums: text("budgetMinimums", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    currencyUnit: text("currencyUnit", { enum: ["cents", "micros", "units"] }).notNull().default("cents"),
    sortOrder: integer("sortOrder").notNull().default(0),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("ad_platforms_code_ux").on(t.code),
  ],
);

export const platformConfigs = sqliteTable(
  "platform_configs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    developerToken: text("developerToken"),
    authorizeUrl: text("authorizeUrl"),
    tokenUrl: text("tokenUrl"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
    apiVersion: text("apiVersion"),
    extra: text("extra", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    isConfigured: integer("isConfigured", { mode: "boolean" }).notNull().default(false),
    platform_id: text("platform_id"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("platform_configs_platform_id_ux").on(t.platform_id),
  ],
);

export const platformConnections = sqliteTable(  "platform_connections",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    status: text("status", { enum: ["not_connected", "healthy", "expiring", "expired", "setup_incomplete", "error", "disconnected"] }).notNull().default("not_connected"),
    externalAccountId: text("externalAccountId"),
    externalAccountName: text("externalAccountName"),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    tokenExpiresAt: integer("tokenExpiresAt", { mode: "timestamp" }),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
    currency: text("currency"),
    setupIssues: text("setupIssues", { mode: "json" }).$type<any[]>().notNull().default(sql`'[]'`),
    lastSyncedAt: integer("lastSyncedAt", { mode: "timestamp" }),
    lastError: text("lastError"),
    meta: text("meta", { mode: "json" }).$type<Record<string, any>>().notNull().default(sql`'{}'`),
    workspace_id: text("workspace_id"),
    platform_id: text("platform_id"),
    account_id: text("account_id").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    deletedAt: integer("deletedAt", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("platform_connections_workspace_id_platform_id_ux").on(t.workspace_id, t.platform_id),
  ],
);

// X (Twitter) OAuth 1.0a request-token secrets. The old backend kept these in
// an in-memory Map; on Workers there is no shared memory between isolates,
// so they live in D1 with a short TTL instead.
export const oauthRequestTokens = sqliteTable("oauth_request_tokens", {
  token: text("token").primaryKey(),
  secret: text("secret").notNull(),
  state: text("state"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
});
