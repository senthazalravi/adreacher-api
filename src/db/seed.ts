// Seed data for the ad_platforms catalog. The old backend seeded these rows
// from the live Supabase ad_platforms table; the values below (objectives,
// budget minimums, unlock copy) mirror that catalog. Platform OAuth app
// credentials are NOT seeded — they come from ADS_<CODE>_* env vars or the
// platform_configs table (see PATCH /platform-configs/:platformCode).
import type { Db } from "./index.js";
import { adPlatforms } from "./schema/index.js";

export interface PlatformSeed {
  id: string;
  code: string;
  name: string;
  kind: "ads" | "social" | "both";
  isEnabled: boolean;
  unlocksCopy: string;
  supportedObjectives: Record<string, string>;
  budgetMinimums: Record<string, unknown>;
  currencyUnit: "cents" | "micros" | "units";
  sortOrder: number;
}

export const PLATFORM_SEEDS: PlatformSeed[] = [
  {
    id: "704aae1d-6a3a-4a08-93b3-cd77c98843f2",
    code: "google_ads",
    name: "Google Ads",
    kind: "ads",
    isEnabled: true,
    unlocksCopy: "Search, Performance Max and Demand Gen campaigns + analytics",
    supportedObjectives: {
      sales: "Sales",
      leads: "Leads",
      website_traffic: "Website traffic",
      app_promotion: "App promotion",
      awareness: "Awareness and consideration",
      local_store_visits: "Local store visits",
    },
    budgetMinimums: { daily: 5, recommendedDaily: 20, supportsLifetimeBudget: false },
    currencyUnit: "micros",
    sortOrder: 10,
  },
  {
    id: "fd9f9e3b-75fe-42f2-8f6f-6fe911f68db9",
    code: "meta",
    name: "Meta",
    kind: "both",
    isEnabled: true,
    unlocksCopy: "Automated ads on Facebook and Instagram + analytics",
    supportedObjectives: {
      awareness: "Awareness",
      traffic: "Traffic",
      engagement: "Engagement",
      leads: "Leads",
      app_promotion: "App promotion",
      sales: "Sales",
    },
    budgetMinimums: { daily: 1, adGroup: 1, recommendedDaily: 10, supportsLifetimeBudget: true },
    currencyUnit: "cents",
    sortOrder: 11,
  },
  {
    id: "8659d838-25fb-4d31-9a3e-cb6585b264c1",
    code: "tiktok",
    name: "TikTok",
    kind: "both",
    isEnabled: true,
    unlocksCopy: "Video campaigns on TikTok + analytics",
    supportedObjectives: {
      reach: "Reach",
      traffic: "Traffic",
      video_views: "Video views",
      community_interaction: "Community interaction",
      app_promotion: "App promotion",
      lead_generation: "Lead generation",
      website_conversions: "Website conversions",
    },
    budgetMinimums: { daily: 20, adGroup: 20, recommendedDaily: 50, supportsLifetimeBudget: true },
    currencyUnit: "cents",
    sortOrder: 12,
  },
  {
    id: "440d9602-59ba-4643-9f1a-444646c540c4",
    code: "x",
    name: "X",
    kind: "both",
    isEnabled: true,
    unlocksCopy: "Campaigns + analytics on X",
    supportedObjectives: {
      reach: "Reach",
      video_views: "Video views",
      website_conversions: "Website conversions",
      app_installs: "App installs",
      followers: "Followers",
      engagements: "Engagements",
    },
    budgetMinimums: { daily: 10, recommendedDaily: 30, supportsLifetimeBudget: false },
    currencyUnit: "cents",
    sortOrder: 13,
  },
  {
    id: "0a3ebeca-0171-40a2-93fb-df70fe3d9a4b",
    code: "reddit",
    name: "Reddit",
    kind: "both",
    isEnabled: true,
    unlocksCopy: "Community-targeted ads + analytics",
    supportedObjectives: {
      awareness: "Awareness",
      traffic: "Traffic",
      conversions: "Conversions",
      video_views: "Video views",
      app_installs: "App installs",
    },
    budgetMinimums: { daily: 5, adGroup: 5, recommendedDaily: 20, supportsLifetimeBudget: true },
    currencyUnit: "cents",
    sortOrder: 14,
  },
  {
    id: "11376613-cf3d-4688-bca6-c66aaf1a5a6e",
    code: "pinterest",
    name: "Pinterest",
    kind: "social",
    isEnabled: true,
    unlocksCopy: "Shopping pins + audience insights",
    supportedObjectives: {
      awareness: "Brand awareness",
      video_views: "Video views",
      consideration: "Consideration",
      conversions: "Conversions",
      catalog_sales: "Catalog sales",
    },
    budgetMinimums: { daily: 5, adGroup: 5, recommendedDaily: 20, supportsLifetimeBudget: true },
    currencyUnit: "cents",
    sortOrder: 15,
  },
  {
    id: "5977b29b-54ac-4bbf-9d35-ee32f6bca232",
    code: "bing_ads",
    name: "Bing",
    kind: "ads",
    isEnabled: true,
    unlocksCopy: "Search campaigns on Bing + analytics",
    supportedObjectives: {
      sales: "Sales",
      leads: "Leads",
      website_traffic: "Website traffic",
      app_promotion: "App promotion",
    },
    budgetMinimums: { daily: 5, recommendedDaily: 20, supportsLifetimeBudget: false },
    currencyUnit: "cents",
    sortOrder: 16,
  },
  {
    id: "6d8ff6f4-4b5e-4e25-aca3-0046baa60300",
    code: "openai_ads",
    name: "OpenAI Ads",
    kind: "ads",
    isEnabled: true,
    unlocksCopy: "Chat-card ads inside ChatGPT",
    supportedObjectives: {
      awareness: "Awareness",
      traffic: "Traffic",
      conversions: "Conversions",
    },
    budgetMinimums: { daily: 10, recommendedDaily: 30, supportsLifetimeBudget: true },
    currencyUnit: "cents",
    sortOrder: 17,
  },
  {
    id: "b21e234d-0a68-4e5c-8499-d8244b156e4f",
    code: "youtube_ads",
    name: "YouTube Ads",
    kind: "ads",
    isEnabled: false,
    unlocksCopy: "Video campaigns via Google Ads",
    supportedObjectives: {
      awareness: "Brand awareness and reach",
      consideration: "Product and brand consideration",
      action: "Drive action",
    },
    budgetMinimums: { daily: 10, recommendedDaily: 30, supportsLifetimeBudget: false },
    currencyUnit: "micros",
    sortOrder: 18,
  },
];

/** Idempotent upsert of the platform catalog (safe to run on every deploy). */
export async function seedPlatforms(db: Db): Promise<number> {
  let n = 0;
  for (const p of PLATFORM_SEEDS) {
    await db
      .insert(adPlatforms)
      .values({
        id: p.id,
        code: p.code,
        name: p.name,
        kind: p.kind,
        isEnabled: p.isEnabled,
        unlocksCopy: p.unlocksCopy,
        supportedObjectives: p.supportedObjectives,
        budgetMinimums: p.budgetMinimums,
        currencyUnit: p.currencyUnit,
        sortOrder: p.sortOrder,
      })
      .onConflictDoNothing({ target: adPlatforms.code });
    n++;
  }
  return n;
}
