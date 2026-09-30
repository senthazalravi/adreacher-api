// AI campaign templates — one per Google format, written for the workspace's brand.
//
// Port of the old lib/templates.js. The shape the frontend reads is v1's: a
// `campaign_templates` row whose `definition` carries `source: "auto_generated"`,
// `generationStatus`, `platformConfig` (with `catalogId`), `targetingConfig` and `adConfig`.
//
// Template generation is AI-driven and arrives in Phase 5. This module carries the
// catalog, the row-shape builders, and the workspace generation lock so Phase 5
// can drop the generation loop in without changing the routes.
import { campaignTemplates } from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { HttpError } from "./filter.js";
import type { BrandView } from "./creatives.js";

/** The Google formats a brand gets a template for. Mirrors reach_be's template-platforms catalogue. */
export const GOOGLE_TEMPLATE_CATALOG = [
  { id: "google-pmax", campaignType: "PERFORMANCE_MAX", adFormat: "pmax_asset_group", previewAspect: "collage", objective: "sales", label: "Performance Max", bestFor: "Conversions across Search, YouTube, Display & Maps" },
  { id: "google-search", campaignType: "SEARCH", adFormat: "search_rsa", previewAspect: "text", objective: "leads", label: "Search (RSA)", bestFor: "High-intent keyword traffic and lead gen" },
  { id: "google-demand-gen", campaignType: "DEMAND_GEN", adFormat: "demand_gen_image", previewAspect: "1:1", objective: "traffic", label: "Demand Gen", bestFor: "Visual discovery on YouTube, Discover & Gmail" },
  { id: "google-demand-gen-carousel", campaignType: "DEMAND_GEN", adFormat: "demand_gen_carousel", previewAspect: "1:1", objective: "engagement", label: "Demand Gen Carousel", bestFor: "Multi-image storytelling in visual feeds" },
  { id: "google-display", campaignType: "DISPLAY", adFormat: "display_banner", previewAspect: "1.91:1", objective: "awareness", label: "Display", bestFor: "Banner reach across the Google Display Network" },
  { id: "google-video", campaignType: "VIDEO", adFormat: "video_youtube", previewAspect: "16:9", objective: "awareness", label: "YouTube Video", bestFor: "Brand reach and recall on YouTube" },
];

/**
 * The objective as stored on `campaigns.objective`. The frontend maps these back
 * to its own vocabulary (`objectiveToUi`): there is no "engagement" or "app_promotion" key —
 * engagement is `messages`, and app promotion has no Google format, so it falls to traffic.
 */
const OBJECTIVE_KEY: Record<string, string> = {
  sales: "online_sales", leads: "leads", traffic: "website_visitors",
  engagement: "messages", app_promotion: "website_visitors", awareness: "awareness",
};

// One generation at a time per workspace — a second click must not double the AI spend.
const active = new Map<string, unknown>();
export const isGenerating = (workspaceId: string) => active.has(workspaceId);

function needsImage(entry: { previewAspect: string; adFormat: string }) {
  return entry.previewAspect !== "text" && entry.adFormat !== "video_youtube";
}

/** Row shape for an auto-generated template, written up-front as `generating`. */
export function baseRow(
  workspaceId: string,
  accountId: string,
  brand: BrandView,
  entry: { id: string; campaignType: string; adFormat: string; previewAspect: string; objective: string; label: string; bestFor: string },
  extra: Record<string, any> = {},
) {
  return {
    workspace_id: workspaceId,
    account_id: accountId,
    name: `${brand.name} — ${entry.label}`,
    description: entry.bestFor,
    objective: OBJECTIVE_KEY[entry.objective] || entry.objective,
    isGallery: false,
    formats: [entry.adFormat],
    usageCount: 0,
    definition: {
      budgetType: "daily",
      budgetAmount: null,
      platform: "google",
      source: "auto_generated",
      brandSourceUrl: brand.sourceUrl || null,
      campaignType: entry.campaignType,
      adFormat: entry.adFormat,
      previewAspect: entry.previewAspect,
      platformConfig: { platform: "google", googleCampaignType: entry.campaignType, label: entry.label, bestFor: entry.bestFor, catalogId: entry.id },
      targetingConfig: {},
      adConfig: { logoUrl: brand.logoUrl || "", imageStatus: needsImage(entry) ? "pending" : "ready" },
      generationStatus: "generating",
      generatedAt: null,
      ...extra,
    },
  };
}

/**
 * Generate the six format templates for a workspace's brand. AI-driven — Phase 5.
 * Kept as a named stub so routes and Phase 5 wiring share the same entry point.
 */
export async function generateTemplatesForBrand(
  _db: Db,
  _env: Record<string, string | undefined>,
  _workspaceId: string,
  _accountId: string,
  _uid?: string | null,
): Promise<never> {
  throw new HttpError(501, "AI template generation arrives in Phase 5", "NOT_IMPLEMENTED");
}

/** Import shared templates from the gallery into the workspace (Phase 5, AI copy may vary). */
export async function importGalleryTemplates(
  _db: Db,
  _workspaceId: string,
  _accountId: string,
  _templateIds: string[],
): Promise<never> {
  throw new HttpError(501, "Template gallery import arrives in Phase 5", "NOT_IMPLEMENTED");
}

// Re-exported so the future Phase 5 generation loop can upsert rows through this module.
export { campaignTemplates };
