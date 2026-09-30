PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ad_platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'ads' NOT NULL,
	`isEnabled` integer DEFAULT true NOT NULL,
	`unlocksCopy` text,
	`supportedObjectives` text DEFAULT '{}' NOT NULL,
	`budgetMinimums` text DEFAULT '{}' NOT NULL,
	`currencyUnit` text DEFAULT 'cents' NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_ad_platforms`("id", "code", "name", "kind", "isEnabled", "unlocksCopy", "supportedObjectives", "budgetMinimums", "currencyUnit", "sortOrder", "createdAt", "updatedAt") SELECT "id", "code", "name", "kind", "isEnabled", "unlocksCopy", "supportedObjectives", "budgetMinimums", "currencyUnit", "sortOrder", "createdAt", "updatedAt" FROM `ad_platforms`;--> statement-breakpoint
DROP TABLE `ad_platforms`;--> statement-breakpoint
ALTER TABLE `__new_ad_platforms` RENAME TO `ad_platforms`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ad_platforms_code_unique` ON `ad_platforms` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `ad_platforms_code_ux` ON `ad_platforms` (`code`);--> statement-breakpoint
CREATE TABLE `__new_brand_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceUrl` text,
	`business` text DEFAULT '{}' NOT NULL,
	`branding` text DEFAULT '{}' NOT NULL,
	`toneOfVoice` text DEFAULT '[]',
	`audience` text DEFAULT '{}',
	`keywords` text DEFAULT '[]',
	`suggestedCampaigns` text DEFAULT '[]',
	`scrapeStatus` text DEFAULT 'pending' NOT NULL,
	`scrapeError` text,
	`lastScrapedAt` integer,
	`onboardingCompletedAt` integer,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_brand_profiles`("id", "sourceUrl", "business", "branding", "toneOfVoice", "audience", "keywords", "suggestedCampaigns", "scrapeStatus", "scrapeError", "lastScrapedAt", "onboardingCompletedAt", "workspace_id", "account_id", "createdAt", "updatedAt") SELECT "id", "sourceUrl", "business", "branding", "toneOfVoice", "audience", "keywords", "suggestedCampaigns", "scrapeStatus", "scrapeError", "lastScrapedAt", "onboardingCompletedAt", "workspace_id", "account_id", "createdAt", "updatedAt" FROM `brand_profiles`;--> statement-breakpoint
DROP TABLE `brand_profiles`;--> statement-breakpoint
ALTER TABLE `__new_brand_profiles` RENAME TO `brand_profiles`;--> statement-breakpoint
CREATE TABLE `__new_brand_scrape_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`sourceUrl` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`result` text DEFAULT '{}',
	`error` text,
	`claimedByWorkspace_Id` text,
	`claimedAt` integer,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_brand_scrape_drafts`("id", "token", "sourceUrl", "status", "steps", "result", "error", "claimedByWorkspace_Id", "claimedAt", "expiresAt", "createdAt", "updatedAt") SELECT "id", "token", "sourceUrl", "status", "steps", "result", "error", "claimedByWorkspace_Id", "claimedAt", "expiresAt", "createdAt", "updatedAt" FROM `brand_scrape_drafts`;--> statement-breakpoint
DROP TABLE `brand_scrape_drafts`;--> statement-breakpoint
ALTER TABLE `__new_brand_scrape_drafts` RENAME TO `brand_scrape_drafts`;--> statement-breakpoint
CREATE UNIQUE INDEX `brand_scrape_drafts_token_unique` ON `brand_scrape_drafts` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `brand_scrape_drafts_token_ux` ON `brand_scrape_drafts` (`token`);--> statement-breakpoint
CREATE TABLE `__new_platform_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text,
	`clientSecret` text,
	`developerToken` text,
	`authorizeUrl` text,
	`tokenUrl` text,
	`scopes` text DEFAULT '[]',
	`apiVersion` text,
	`extra` text DEFAULT '{}' NOT NULL,
	`isConfigured` integer DEFAULT false NOT NULL,
	`platform_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_platform_configs`("id", "clientId", "clientSecret", "developerToken", "authorizeUrl", "tokenUrl", "scopes", "apiVersion", "extra", "isConfigured", "platform_id", "createdAt", "updatedAt") SELECT "id", "clientId", "clientSecret", "developerToken", "authorizeUrl", "tokenUrl", "scopes", "apiVersion", "extra", "isConfigured", "platform_id", "createdAt", "updatedAt" FROM `platform_configs`;--> statement-breakpoint
DROP TABLE `platform_configs`;--> statement-breakpoint
ALTER TABLE `__new_platform_configs` RENAME TO `platform_configs`;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_configs_platform_id_ux` ON `platform_configs` (`platform_id`);--> statement-breakpoint
CREATE TABLE `__new_platform_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'not_connected' NOT NULL,
	`externalAccountId` text,
	`externalAccountName` text,
	`accessToken` text,
	`refreshToken` text,
	`tokenExpiresAt` integer,
	`scopes` text DEFAULT '[]',
	`currency` text,
	`setupIssues` text DEFAULT '[]' NOT NULL,
	`lastSyncedAt` integer,
	`lastError` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`workspace_id` text,
	`platform_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_platform_connections`("id", "status", "externalAccountId", "externalAccountName", "accessToken", "refreshToken", "tokenExpiresAt", "scopes", "currency", "setupIssues", "lastSyncedAt", "lastError", "meta", "workspace_id", "platform_id", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "status", "externalAccountId", "externalAccountName", "accessToken", "refreshToken", "tokenExpiresAt", "scopes", "currency", "setupIssues", "lastSyncedAt", "lastError", "meta", "workspace_id", "platform_id", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `platform_connections`;--> statement-breakpoint
DROP TABLE `platform_connections`;--> statement-breakpoint
ALTER TABLE `__new_platform_connections` RENAME TO `platform_connections`;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_connections_workspace_id_platform_id_ux` ON `platform_connections` (`workspace_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `__new_campaign_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`occurredAt` integer NOT NULL,
	`campaign_id` text,
	`actor_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaign_activities`("id", "type", "message", "meta", "occurredAt", "campaign_id", "actor_id", "account_id", "createdAt", "updatedAt") SELECT "id", "type", "message", "meta", "occurredAt", "campaign_id", "actor_id", "account_id", "createdAt", "updatedAt" FROM `campaign_activities`;--> statement-breakpoint
DROP TABLE `campaign_activities`;--> statement-breakpoint
ALTER TABLE `__new_campaign_activities` RENAME TO `campaign_activities`;--> statement-breakpoint
CREATE TABLE `__new_campaign_iterations` (
	`id` text PRIMARY KEY NOT NULL,
	`iterationNumber` integer DEFAULT 1 NOT NULL,
	`changeSummary` text,
	`result` text DEFAULT 'running' NOT NULL,
	`ctr` real,
	`impressions` integer DEFAULT 0 NOT NULL,
	`score` real,
	`promotedAt` integer,
	`snapshot` text DEFAULT '{}' NOT NULL,
	`campaign_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaign_iterations`("id", "iterationNumber", "changeSummary", "result", "ctr", "impressions", "score", "promotedAt", "snapshot", "campaign_id", "account_id", "createdAt", "updatedAt") SELECT "id", "iterationNumber", "changeSummary", "result", "ctr", "impressions", "score", "promotedAt", "snapshot", "campaign_id", "account_id", "createdAt", "updatedAt" FROM `campaign_iterations`;--> statement-breakpoint
DROP TABLE `campaign_iterations`;--> statement-breakpoint
ALTER TABLE `__new_campaign_iterations` RENAME TO `campaign_iterations`;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_iterations_campaign_id_iterationNumber_ux` ON `campaign_iterations` (`campaign_id`,`iterationNumber`);--> statement-breakpoint
CREATE TABLE `__new_campaign_platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`externalCampaignId` text,
	`campaignType` text,
	`nativeObjective` text,
	`budgetAmount` real,
	`spend` real DEFAULT 0 NOT NULL,
	`platformMessage` text,
	`failureCode` text,
	`lastSyncedAt` integer,
	`publishedAt` integer,
	`payload` text DEFAULT '{}' NOT NULL,
	`campaign_id` text,
	`platform_id` text,
	`connection_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaign_platforms`("id", "status", "externalCampaignId", "campaignType", "nativeObjective", "budgetAmount", "spend", "platformMessage", "failureCode", "lastSyncedAt", "publishedAt", "payload", "campaign_id", "platform_id", "connection_id", "account_id", "createdAt", "updatedAt") SELECT "id", "status", "externalCampaignId", "campaignType", "nativeObjective", "budgetAmount", "spend", "platformMessage", "failureCode", "lastSyncedAt", "publishedAt", "payload", "campaign_id", "platform_id", "connection_id", "account_id", "createdAt", "updatedAt" FROM `campaign_platforms`;--> statement-breakpoint
DROP TABLE `campaign_platforms`;--> statement-breakpoint
ALTER TABLE `__new_campaign_platforms` RENAME TO `campaign_platforms`;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_platforms_campaign_id_platform_id_ux` ON `campaign_platforms` (`campaign_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `__new_campaign_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`objective` text,
	`definition` text DEFAULT '{}' NOT NULL,
	`isGallery` integer DEFAULT false NOT NULL,
	`formats` text DEFAULT '[]',
	`usageCount` integer DEFAULT 0 NOT NULL,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_campaign_templates`("id", "name", "description", "objective", "definition", "isGallery", "formats", "usageCount", "workspace_id", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "name", "description", "objective", "definition", "isGallery", "formats", "usageCount", "workspace_id", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `campaign_templates`;--> statement-breakpoint
DROP TABLE `campaign_templates`;--> statement-breakpoint
ALTER TABLE `__new_campaign_templates` RENAME TO `campaign_templates`;--> statement-breakpoint
CREATE TABLE `__new_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`objective` text DEFAULT 'local_visits' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`budgetType` text DEFAULT 'daily' NOT NULL,
	`budgetAmount` real,
	`currency` text DEFAULT 'SEK' NOT NULL,
	`startDate` integer,
	`endDate` integer,
	`builderStage` text DEFAULT 'goal' NOT NULL,
	`draftState` text DEFAULT '{}' NOT NULL,
	`hasUnpublishedChanges` integer DEFAULT false NOT NULL,
	`pendingChanges` text DEFAULT '{}' NOT NULL,
	`landingPageUrl` text,
	`requireLandingApproval` integer DEFAULT false NOT NULL,
	`landingPageApprovedAt` integer,
	`trackingFinalUrl` text,
	`includeGoogleTag` integer DEFAULT false NOT NULL,
	`includeFacebookPixel` integer DEFAULT false NOT NULL,
	`tracking` text DEFAULT '{}' NOT NULL,
	`autoOptimize` integer DEFAULT false NOT NULL,
	`autoOptimizeConfig` text DEFAULT '{}' NOT NULL,
	`nextOptimizationAt` integer,
	`source` text DEFAULT 'app' NOT NULL,
	`notes` text,
	`workspace_id` text,
	`createdBy_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "name", "objective", "status", "budgetType", "budgetAmount", "currency", "startDate", "endDate", "builderStage", "draftState", "hasUnpublishedChanges", "pendingChanges", "landingPageUrl", "requireLandingApproval", "landingPageApprovedAt", "trackingFinalUrl", "includeGoogleTag", "includeFacebookPixel", "tracking", "autoOptimize", "autoOptimizeConfig", "nextOptimizationAt", "source", "notes", "workspace_id", "createdBy_id", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "name", "objective", "status", "budgetType", "budgetAmount", "currency", "startDate", "endDate", "builderStage", "draftState", "hasUnpublishedChanges", "pendingChanges", "landingPageUrl", "requireLandingApproval", "landingPageApprovedAt", "trackingFinalUrl", "includeGoogleTag", "includeFacebookPixel", "tracking", "autoOptimize", "autoOptimizeConfig", "nextOptimizationAt", "source", "notes", "workspace_id", "createdBy_id", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `campaigns`;--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
CREATE TABLE `__new_campaign_analytics` (
	`id` text PRIMARY KEY NOT NULL,
	`date` integer NOT NULL,
	`hour` integer,
	`impressions` integer DEFAULT 0 NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`conversions` integer DEFAULT 0 NOT NULL,
	`storeVisits` integer DEFAULT 0 NOT NULL,
	`spend` real DEFAULT 0 NOT NULL,
	`revenue` real DEFAULT 0 NOT NULL,
	`ctr` real,
	`cpc` real,
	`cpa` real,
	`roas` real,
	`frequency` real,
	`deviceBreakdown` text DEFAULT '{}' NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`workspace_id` text,
	`campaign_id` text,
	`platform_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaign_analytics`("id", "date", "hour", "impressions", "clicks", "conversions", "storeVisits", "spend", "revenue", "ctr", "cpc", "cpa", "roas", "frequency", "deviceBreakdown", "metrics", "workspace_id", "campaign_id", "platform_id", "account_id", "createdAt", "updatedAt") SELECT "id", "date", "hour", "impressions", "clicks", "conversions", "storeVisits", "spend", "revenue", "ctr", "cpc", "cpa", "roas", "frequency", "deviceBreakdown", "metrics", "workspace_id", "campaign_id", "platform_id", "account_id", "createdAt", "updatedAt" FROM `campaign_analytics`;--> statement-breakpoint
DROP TABLE `campaign_analytics`;--> statement-breakpoint
ALTER TABLE `__new_campaign_analytics` RENAME TO `campaign_analytics`;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_analytics_campaign_id_platform_id_date_hour_ux` ON `campaign_analytics` (`campaign_id`,`platform_id`,`date`,`hour`);--> statement-breakpoint
CREATE TABLE `__new_campaign_landing_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text DEFAULT '{}' NOT NULL,
	`theme` text DEFAULT '{}' NOT NULL,
	`ctaDestinationUrl` text,
	`error` text,
	`publishedAt` integer,
	`workspace_id` text,
	`campaign_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaign_landing_pages`("id", "slug", "status", "version", "content", "theme", "ctaDestinationUrl", "error", "publishedAt", "workspace_id", "campaign_id", "account_id", "createdAt", "updatedAt") SELECT "id", "slug", "status", "version", "content", "theme", "ctaDestinationUrl", "error", "publishedAt", "workspace_id", "campaign_id", "account_id", "createdAt", "updatedAt" FROM `campaign_landing_pages`;--> statement-breakpoint
DROP TABLE `campaign_landing_pages`;--> statement-breakpoint
ALTER TABLE `__new_campaign_landing_pages` RENAME TO `campaign_landing_pages`;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_landing_pages_slug_ux` ON `campaign_landing_pages` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_campaign_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`platformPostId` text,
	`platformAdId` text,
	`targeting` text DEFAULT '{}' NOT NULL,
	`platformCreative` text DEFAULT '{}' NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`reviewStatus` text DEFAULT 'pending' NOT NULL,
	`reviewFeedback` text,
	`startedAt` integer,
	`endedAt` integer,
	`campaign_id` text,
	`post_id` text,
	`platform_id` text,
	`connection_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaign_posts`("id", "platformPostId", "platformAdId", "targeting", "platformCreative", "metrics", "reviewStatus", "reviewFeedback", "startedAt", "endedAt", "campaign_id", "post_id", "platform_id", "connection_id", "account_id", "createdAt", "updatedAt") SELECT "id", "platformPostId", "platformAdId", "targeting", "platformCreative", "metrics", "reviewStatus", "reviewFeedback", "startedAt", "endedAt", "campaign_id", "post_id", "platform_id", "connection_id", "account_id", "createdAt", "updatedAt" FROM `campaign_posts`;--> statement-breakpoint
DROP TABLE `campaign_posts`;--> statement-breakpoint
ALTER TABLE `__new_campaign_posts` RENAME TO `campaign_posts`;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_posts_campaign_id_post_id_platform_id_ux` ON `campaign_posts` (`campaign_id`,`post_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `__new_creatives` (
	`id` text PRIMARY KEY NOT NULL,
	`headline` text,
	`body` text,
	`shotType` text,
	`subject` text,
	`aspectRatios` text DEFAULT '[]',
	`placements` text DEFAULT '[]',
	`status` text DEFAULT 'pending' NOT NULL,
	`rejectReason` text,
	`rejectNote` text,
	`isAiGenerated` integer DEFAULT true NOT NULL,
	`prompt` text,
	`brandContext` text DEFAULT '{}' NOT NULL,
	`generationMeta` text DEFAULT '{}' NOT NULL,
	`generatedAt` integer,
	`reviewedAt` integer,
	`workspace_id` text,
	`campaign_id` text,
	`mediaAsset_id` text,
	`reviewedBy_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_creatives`("id", "headline", "body", "shotType", "subject", "aspectRatios", "placements", "status", "rejectReason", "rejectNote", "isAiGenerated", "prompt", "brandContext", "generationMeta", "generatedAt", "reviewedAt", "workspace_id", "campaign_id", "mediaAsset_id", "reviewedBy_id", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "headline", "body", "shotType", "subject", "aspectRatios", "placements", "status", "rejectReason", "rejectNote", "isAiGenerated", "prompt", "brandContext", "generationMeta", "generatedAt", "reviewedAt", "workspace_id", "campaign_id", "mediaAsset_id", "reviewedBy_id", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `creatives`;--> statement-breakpoint
DROP TABLE `creatives`;--> statement-breakpoint
ALTER TABLE `__new_creatives` RENAME TO `creatives`;--> statement-breakpoint
CREATE TABLE `__new_media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`file_Id` text,
	`fileName` text NOT NULL,
	`fileType` text DEFAULT 'image' NOT NULL,
	`mimeType` text NOT NULL,
	`url` text NOT NULL,
	`thumbnailUrl` text,
	`sizeBytes` integer,
	`width` integer,
	`height` integer,
	`durationSeconds` integer,
	`altText` text,
	`source` text DEFAULT 'upload' NOT NULL,
	`tags` text DEFAULT '[]',
	`metadata` text DEFAULT '{}' NOT NULL,
	`workspace_id` text,
	`uploadedBy_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_media_assets`("id", "file_Id", "fileName", "fileType", "mimeType", "url", "thumbnailUrl", "sizeBytes", "width", "height", "durationSeconds", "altText", "source", "tags", "metadata", "workspace_id", "uploadedBy_id", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "file_Id", "fileName", "fileType", "mimeType", "url", "thumbnailUrl", "sizeBytes", "width", "height", "durationSeconds", "altText", "source", "tags", "metadata", "workspace_id", "uploadedBy_id", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `media_assets`;--> statement-breakpoint
DROP TABLE `media_assets`;--> statement-breakpoint
ALTER TABLE `__new_media_assets` RENAME TO `media_assets`;--> statement-breakpoint
CREATE TABLE `__new_platform_post_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`isRequired` integer DEFAULT false NOT NULL,
	`labelOverride` text,
	`placeholder` text,
	`helpText` text,
	`validationOverride` text DEFAULT '{}',
	`optionsOverride` text DEFAULT '[]',
	`displayOrder` integer DEFAULT 0 NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`platform_id` text,
	`field_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_platform_post_fields`("id", "isRequired", "labelOverride", "placeholder", "helpText", "validationOverride", "optionsOverride", "displayOrder", "isActive", "platform_id", "field_id", "createdAt", "updatedAt") SELECT "id", "isRequired", "labelOverride", "placeholder", "helpText", "validationOverride", "optionsOverride", "displayOrder", "isActive", "platform_id", "field_id", "createdAt", "updatedAt" FROM `platform_post_fields`;--> statement-breakpoint
DROP TABLE `platform_post_fields`;--> statement-breakpoint
ALTER TABLE `__new_platform_post_fields` RENAME TO `platform_post_fields`;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_post_fields_platform_id_field_id_ux` ON `platform_post_fields` (`platform_id`,`field_id`);--> statement-breakpoint
CREATE TABLE `__new_post_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`fieldType` text DEFAULT 'text' NOT NULL,
	`scope` text DEFAULT 'post' NOT NULL,
	`defaultValidation` text DEFAULT '{}' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`description` text,
	`displayOrder` integer DEFAULT 0 NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_post_fields`("id", "name", "label", "fieldType", "scope", "defaultValidation", "options", "description", "displayOrder", "isActive", "createdAt", "updatedAt") SELECT "id", "name", "label", "fieldType", "scope", "defaultValidation", "options", "description", "displayOrder", "isActive", "createdAt", "updatedAt" FROM `post_fields`;--> statement-breakpoint
DROP TABLE `post_fields`;--> statement-breakpoint
ALTER TABLE `__new_post_fields` RENAME TO `post_fields`;--> statement-breakpoint
CREATE UNIQUE INDEX `post_fields_name_unique` ON `post_fields` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_fields_name_ux` ON `post_fields` (`name`);--> statement-breakpoint
CREATE TABLE `__new_post_media` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`media_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_post_media`("id", "post_id", "media_id", "createdAt", "updatedAt") SELECT "id", "post_id", "media_id", "createdAt", "updatedAt" FROM `post_media`;--> statement-breakpoint
DROP TABLE `post_media`;--> statement-breakpoint
ALTER TABLE `__new_post_media` RENAME TO `post_media`;--> statement-breakpoint
CREATE UNIQUE INDEX `post_media_post_id_media_id_ux` ON `post_media` (`post_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `__new_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`headline` text,
	`body` text,
	`description` text,
	`postType` text DEFAULT 'organic' NOT NULL,
	`contentType` text DEFAULT 'image' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`format` text,
	`scheduledAt` integer,
	`publishedAt` integer,
	`callToAction` text,
	`destinationUrl` text,
	`fieldValues` text DEFAULT '{}' NOT NULL,
	`schedulingMetadata` text DEFAULT '{}' NOT NULL,
	`imagePrompt` text,
	`metrics` text DEFAULT '{}' NOT NULL,
	`notes` text,
	`workspace_id` text,
	`createdBy_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_posts`("id", "title", "headline", "body", "description", "postType", "contentType", "status", "format", "scheduledAt", "publishedAt", "callToAction", "destinationUrl", "fieldValues", "schedulingMetadata", "imagePrompt", "metrics", "notes", "workspace_id", "createdBy_id", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "title", "headline", "body", "description", "postType", "contentType", "status", "format", "scheduledAt", "publishedAt", "callToAction", "destinationUrl", "fieldValues", "schedulingMetadata", "imagePrompt", "metrics", "notes", "workspace_id", "createdBy_id", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `posts`;--> statement-breakpoint
DROP TABLE `posts`;--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;--> statement-breakpoint
CREATE TABLE `__new_scheduled_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduledAt` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`publishedAt` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastAttemptAt` integer,
	`nextRetryAt` integer,
	`jobId` text,
	`errorMessage` text,
	`lastError` text DEFAULT '{}',
	`externalPostId` text,
	`workspace_id` text,
	`post_id` text,
	`platform_id` text,
	`connection_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_scheduled_posts`("id", "scheduledAt", "status", "priority", "publishedAt", "attempts", "lastAttemptAt", "nextRetryAt", "jobId", "errorMessage", "lastError", "externalPostId", "workspace_id", "post_id", "platform_id", "connection_id", "account_id", "createdAt", "updatedAt") SELECT "id", "scheduledAt", "status", "priority", "publishedAt", "attempts", "lastAttemptAt", "nextRetryAt", "jobId", "errorMessage", "lastError", "externalPostId", "workspace_id", "post_id", "platform_id", "connection_id", "account_id", "createdAt", "updatedAt" FROM `scheduled_posts`;--> statement-breakpoint
DROP TABLE `scheduled_posts`;--> statement-breakpoint
ALTER TABLE `__new_scheduled_posts` RENAME TO `scheduled_posts`;--> statement-breakpoint
CREATE TABLE `__new_website_scraped_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`url` text NOT NULL,
	`title` text,
	`metaDescription` text,
	`metaKeywords` text DEFAULT '[]',
	`headings` text DEFAULT '[]' NOT NULL,
	`bodyText` text,
	`ctaButtons` text DEFAULT '[]',
	`images` text DEFAULT '[]' NOT NULL,
	`brandColors` text DEFAULT '[]',
	`brandName` text,
	`fonts` text DEFAULT '[]',
	`extractedAt` integer,
	`draft_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_website_scraped_assets`("id", "workspace_id", "url", "title", "metaDescription", "metaKeywords", "headings", "bodyText", "ctaButtons", "images", "brandColors", "brandName", "fonts", "extractedAt", "draft_id", "createdAt", "updatedAt") SELECT "id", "workspace_id", "url", "title", "metaDescription", "metaKeywords", "headings", "bodyText", "ctaButtons", "images", "brandColors", "brandName", "fonts", "extractedAt", "draft_id", "createdAt", "updatedAt" FROM `website_scraped_assets`;--> statement-breakpoint
DROP TABLE `website_scraped_assets`;--> statement-breakpoint
ALTER TABLE `__new_website_scraped_assets` RENAME TO `website_scraped_assets`;--> statement-breakpoint
CREATE TABLE `__new_agency_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`engagementStartedAt` integer,
	`engagementEndedAt` integer,
	`notes` text,
	`agency_id` text,
	`client_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_agency_clients`("id", "status", "engagementStartedAt", "engagementEndedAt", "notes", "agency_id", "client_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "status", "engagementStartedAt", "engagementEndedAt", "notes", "agency_id", "client_id", "createdAt", "updatedAt", "deletedAt" FROM `agency_clients`;--> statement-breakpoint
DROP TABLE `agency_clients`;--> statement-breakpoint
ALTER TABLE `__new_agency_clients` RENAME TO `agency_clients`;--> statement-breakpoint
CREATE UNIQUE INDEX `agency_clients_agency_id_client_id_ux` ON `agency_clients` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `__new_agency_staff_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`assignedAt` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`agency_id` text,
	`staff_id` text,
	`workspace_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agency_staff_workspaces`("id", "role", "assignedAt", "status", "agency_id", "staff_id", "workspace_id", "createdAt", "updatedAt") SELECT "id", "role", "assignedAt", "status", "agency_id", "staff_id", "workspace_id", "createdAt", "updatedAt" FROM `agency_staff_workspaces`;--> statement-breakpoint
DROP TABLE `agency_staff_workspaces`;--> statement-breakpoint
ALTER TABLE `__new_agency_staff_workspaces` RENAME TO `agency_staff_workspaces`;--> statement-breakpoint
CREATE UNIQUE INDEX `agency_staff_workspaces_agency_id_staff_id_workspace_id_ux` ON `agency_staff_workspaces` (`agency_id`,`staff_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`invitedAt` integer,
	`acceptedAt` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`workspace_id` text,
	`member_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workspace_members`("id", "role", "invitedAt", "acceptedAt", "status", "workspace_id", "member_id", "account_id", "createdAt", "updatedAt") SELECT "id", "role", "invitedAt", "acceptedAt", "status", "workspace_id", "member_id", "account_id", "createdAt", "updatedAt" FROM `workspace_members`;--> statement-breakpoint
DROP TABLE `workspace_members`;--> statement-breakpoint
ALTER TABLE `__new_workspace_members` RENAME TO `workspace_members`;--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspace_id_member_id_ux` ON `workspace_members` (`workspace_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`websiteUrl` text,
	`industry` text,
	`descriptor` text,
	`timezone` text DEFAULT 'Europe/Stockholm' NOT NULL,
	`currency` text DEFAULT 'SEK' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`logo_Id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`onboardingState` text DEFAULT 'pending' NOT NULL,
	`onboardingCompletedAt` integer,
	`isDefault` integer DEFAULT false NOT NULL,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_workspaces`("id", "name", "slug", "websiteUrl", "industry", "descriptor", "timezone", "currency", "locale", "logo_Id", "status", "onboardingState", "onboardingCompletedAt", "isDefault", "account_id", "createdAt", "updatedAt", "deletedAt") SELECT "id", "name", "slug", "websiteUrl", "industry", "descriptor", "timezone", "currency", "locale", "logo_Id", "status", "onboardingState", "onboardingCompletedAt", "isDefault", "account_id", "createdAt", "updatedAt", "deletedAt" FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenantId` text,
	`userId` text,
	`action` text NOT NULL,
	`entityType` text,
	`entityId` text,
	`meta` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_audit_log`("id", "tenantId", "userId", "action", "entityType", "entityId", "meta", "createdAt") SELECT "id", "tenantId", "userId", "action", "entityType", "entityId", "meta", "createdAt" FROM `audit_log`;--> statement-breakpoint
DROP TABLE `audit_log`;--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;--> statement-breakpoint
CREATE TABLE `__new_files` (
	`id` text PRIMARY KEY NOT NULL,
	`tenantId` text,
	`r2Key` text NOT NULL,
	`filename` text NOT NULL,
	`mimeType` text,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`title` text,
	`isPublic` integer DEFAULT false NOT NULL,
	`folder` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_files`("id", "tenantId", "r2Key", "filename", "mimeType", "sizeBytes", "title", "isPublic", "folder", "createdAt") SELECT "id", "tenantId", "r2Key", "filename", "mimeType", "sizeBytes", "title", "isPublic", "folder", "createdAt" FROM `files`;--> statement-breakpoint
DROP TABLE `files`;--> statement-breakpoint
ALTER TABLE `__new_files` RENAME TO `files`;--> statement-breakpoint
CREATE UNIQUE INDEX `files_r2Key_unique` ON `files` (`r2Key`);--> statement-breakpoint
CREATE TABLE `__new_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`tenantId` text NOT NULL,
	`role` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`acceptedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_invites`("id", "email", "tenantId", "role", "token", "expiresAt", "acceptedAt", "createdAt") SELECT "id", "email", "tenantId", "role", "token", "expiresAt", "acceptedAt", "createdAt" FROM `invites`;--> statement-breakpoint
DROP TABLE `invites`;--> statement-breakpoint
ALTER TABLE `__new_invites` RENAME TO `invites`;--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenantId` text,
	`userId` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`data` text,
	`seenAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "tenantId", "userId", "type", "title", "body", "data", "seenAt", "createdAt") SELECT "id", "tenantId", "userId", "type", "title", "body", "data", "seenAt", "createdAt" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
CREATE TABLE `__new_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text DEFAULT 'client' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ownerId` text,
	`planSlug` text,
	`billingEmail` text,
	`contactPerson` text,
	`phones` text,
	`address` text,
	`country` text,
	`orgNumber` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_tenants`("id", "name", "slug", "type", "status", "ownerId", "planSlug", "billingEmail", "contactPerson", "phones", "address", "country", "orgNumber", "createdAt", "updatedAt", "deletedAt") SELECT "id", "name", "slug", "type", "status", "ownerId", "planSlug", "billingEmail", "contactPerson", "phones", "address", "country", "orgNumber", "createdAt", "updatedAt", "deletedAt" FROM `tenants`;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_user_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text,
	`email` text NOT NULL,
	`tenantId` text,
	`type` text NOT NULL,
	`tokenHash` text NOT NULL,
	`data` text,
	`expiresAt` integer NOT NULL,
	`usedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user_tokens`("id", "userId", "email", "tenantId", "type", "tokenHash", "data", "expiresAt", "usedAt", "createdAt") SELECT "id", "userId", "email", "tenantId", "type", "tokenHash", "data", "expiresAt", "usedAt", "createdAt" FROM `user_tokens`;--> statement-breakpoint
DROP TABLE `user_tokens`;--> statement-breakpoint
ALTER TABLE `__new_user_tokens` RENAME TO `user_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_tokens_tokenHash_unique` ON `user_tokens` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`passwordHash` text,
	`firstName` text,
	`lastName` text,
	`tenantId` text,
	`activeWorkspaceId` text,
	`emailVerified` integer DEFAULT false NOT NULL,
	`twoFactorEnabled` integer DEFAULT false NOT NULL,
	`totpSecret` text,
	`platformAdmin` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "passwordHash", "firstName", "lastName", "tenantId", "activeWorkspaceId", "emailVerified", "twoFactorEnabled", "totpSecret", "platformAdmin", "createdAt", "updatedAt", "deletedAt") SELECT "id", "email", "passwordHash", "firstName", "lastName", "tenantId", "activeWorkspaceId", "emailVerified", "twoFactorEnabled", "totpSecret", "platformAdmin", "createdAt", "updatedAt", "deletedAt" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `__new_ai_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`textProvider` text DEFAULT 'gemini' NOT NULL,
	`textModel` text DEFAULT 'gemini-2.5-flash' NOT NULL,
	`textApiKey` text,
	`textBaseUrl` text,
	`fallbackModel` text,
	`imageProvider` text DEFAULT 'fal' NOT NULL,
	`imageModel` text,
	`imageApiKey` text,
	`keyOverridden` integer DEFAULT false NOT NULL,
	`modelOverridden` integer DEFAULT false NOT NULL,
	`lastTest` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_ai_settings`("id", "textProvider", "textModel", "textApiKey", "textBaseUrl", "fallbackModel", "imageProvider", "imageModel", "imageApiKey", "keyOverridden", "modelOverridden", "lastTest", "createdAt", "updatedAt") SELECT "id", "textProvider", "textModel", "textApiKey", "textBaseUrl", "fallbackModel", "imageProvider", "imageModel", "imageApiKey", "keyOverridden", "modelOverridden", "lastTest", "createdAt", "updatedAt" FROM `ai_settings`;--> statement-breakpoint
DROP TABLE `ai_settings`;--> statement-breakpoint
ALTER TABLE `__new_ai_settings` RENAME TO `ai_settings`;--> statement-breakpoint
CREATE TABLE `__new_billing_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`stripePublishableKey` text,
	`stripeSecretKey` text,
	`stripeWebhookSecret` text,
	`defaultCurrency` text DEFAULT 'SEK' NOT NULL,
	`trialDays` integer DEFAULT 14 NOT NULL,
	`testMode` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_billing_settings`("id", "stripePublishableKey", "stripeSecretKey", "stripeWebhookSecret", "defaultCurrency", "trialDays", "testMode", "createdAt", "updatedAt") SELECT "id", "stripePublishableKey", "stripeSecretKey", "stripeWebhookSecret", "defaultCurrency", "trialDays", "testMode", "createdAt", "updatedAt" FROM `billing_settings`;--> statement-breakpoint
DROP TABLE `billing_settings`;--> statement-breakpoint
ALTER TABLE `__new_billing_settings` RENAME TO `billing_settings`;--> statement-breakpoint
CREATE TABLE `__new_dashboard_metric_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`platformCode` text DEFAULT 'all' NOT NULL,
	`metricKeys` text DEFAULT '[]' NOT NULL,
	`owner_id` text,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_dashboard_metric_prefs`("id", "platformCode", "metricKeys", "owner_id", "workspace_id", "account_id", "createdAt", "updatedAt") SELECT "id", "platformCode", "metricKeys", "owner_id", "workspace_id", "account_id", "createdAt", "updatedAt" FROM `dashboard_metric_prefs`;--> statement-breakpoint
DROP TABLE `dashboard_metric_prefs`;--> statement-breakpoint
ALTER TABLE `__new_dashboard_metric_prefs` RENAME TO `dashboard_metric_prefs`;--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_metric_prefs_owner_id_workspace_id_platformCode_ux` ON `dashboard_metric_prefs` (`owner_id`,`workspace_id`,`platformCode`);--> statement-breakpoint
CREATE TABLE `__new_deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'account' NOT NULL,
	`targetId` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requestedAt` integer NOT NULL,
	`scheduledDeletionDate` integer,
	`completedAt` integer,
	`notes` text,
	`requestedBy_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_deletion_requests`("id", "scope", "targetId", "status", "requestedAt", "scheduledDeletionDate", "completedAt", "notes", "requestedBy_id", "createdAt", "updatedAt") SELECT "id", "scope", "targetId", "status", "requestedAt", "scheduledDeletionDate", "completedAt", "notes", "requestedBy_id", "createdAt", "updatedAt" FROM `deletion_requests`;--> statement-breakpoint
DROP TABLE `deletion_requests`;--> statement-breakpoint
ALTER TABLE `__new_deletion_requests` RENAME TO `deletion_requests`;--> statement-breakpoint
CREATE TABLE `__new_notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`inAppEnabled` integer DEFAULT true NOT NULL,
	`toastEnabled` integer DEFAULT true NOT NULL,
	`emailEnabled` integer DEFAULT true NOT NULL,
	`categories` text DEFAULT '{}' NOT NULL,
	`digestFrequency` text DEFAULT 'instant' NOT NULL,
	`recipient_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notification_preferences`("id", "inAppEnabled", "toastEnabled", "emailEnabled", "categories", "digestFrequency", "recipient_id", "createdAt", "updatedAt") SELECT "id", "inAppEnabled", "toastEnabled", "emailEnabled", "categories", "digestFrequency", "recipient_id", "createdAt", "updatedAt" FROM `notification_preferences`;--> statement-breakpoint
DROP TABLE `notification_preferences`;--> statement-breakpoint
ALTER TABLE `__new_notification_preferences` RENAME TO `notification_preferences`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_recipient_id_ux` ON `notification_preferences` (`recipient_id`);--> statement-breakpoint
CREATE TABLE `__new_subscription_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`audience` text DEFAULT 'client' NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'SEK' NOT NULL,
	`billingInterval` text DEFAULT 'month' NOT NULL,
	`trialDays` integer DEFAULT 14 NOT NULL,
	`stripeProductId` text,
	`stripePriceId` text,
	`entitlements` text DEFAULT '{}' NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`displayOrder` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_subscription_plans`("id", "slug", "name", "audience", "price", "currency", "billingInterval", "trialDays", "stripeProductId", "stripePriceId", "entitlements", "isActive", "displayOrder", "createdAt", "updatedAt") SELECT "id", "slug", "name", "audience", "price", "currency", "billingInterval", "trialDays", "stripeProductId", "stripePriceId", "entitlements", "isActive", "displayOrder", "createdAt", "updatedAt" FROM `subscription_plans`;--> statement-breakpoint
DROP TABLE `subscription_plans`;--> statement-breakpoint
ALTER TABLE `__new_subscription_plans` RENAME TO `subscription_plans`;--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_plans_slug_unique` ON `subscription_plans` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_plans_slug_ux` ON `subscription_plans` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'trialing' NOT NULL,
	`stripeCustomerId` text,
	`stripeSubscriptionId` text,
	`trialEndsAt` integer,
	`currentPeriodStart` integer,
	`currentPeriodEnd` integer,
	`cancelAtPeriodEnd` integer DEFAULT false NOT NULL,
	`canceledAt` integer,
	`entitlementOverrides` text DEFAULT '{}' NOT NULL,
	`plan_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_subscriptions`("id", "status", "stripeCustomerId", "stripeSubscriptionId", "trialEndsAt", "currentPeriodStart", "currentPeriodEnd", "cancelAtPeriodEnd", "canceledAt", "entitlementOverrides", "plan_id", "account_id", "createdAt", "updatedAt") SELECT "id", "status", "stripeCustomerId", "stripeSubscriptionId", "trialEndsAt", "currentPeriodStart", "currentPeriodEnd", "cancelAtPeriodEnd", "canceledAt", "entitlementOverrides", "plan_id", "account_id", "createdAt", "updatedAt" FROM `subscriptions`;--> statement-breakpoint
DROP TABLE `subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_subscriptions` RENAME TO `subscriptions`;--> statement-breakpoint
CREATE TABLE `__new_usage_counters` (
	`id` text PRIMARY KEY NOT NULL,
	`metricKey` text NOT NULL,
	`periodStart` integer NOT NULL,
	`periodEnd` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`limitValue` integer,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_usage_counters`("id", "metricKey", "periodStart", "periodEnd", "count", "limitValue", "workspace_id", "account_id", "createdAt", "updatedAt") SELECT "id", "metricKey", "periodStart", "periodEnd", "count", "limitValue", "workspace_id", "account_id", "createdAt", "updatedAt" FROM `usage_counters`;--> statement-breakpoint
DROP TABLE `usage_counters`;--> statement-breakpoint
ALTER TABLE `__new_usage_counters` RENAME TO `usage_counters`;--> statement-breakpoint
CREATE TABLE `__new_user_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`preferredLanguage` text DEFAULT 'en' NOT NULL,
	`timezone` text,
	`address` text DEFAULT '{}' NOT NULL,
	`consents` text DEFAULT '{}' NOT NULL,
	`lastActiveAccount_Id` text,
	`lastActiveWorkspace_Id` text,
	`uiPreferences` text DEFAULT '{}' NOT NULL,
	`onboardingChecklist` text DEFAULT '{}' NOT NULL,
	`owner_id` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user_profiles`("id", "preferredLanguage", "timezone", "address", "consents", "lastActiveAccount_Id", "lastActiveWorkspace_Id", "uiPreferences", "onboardingChecklist", "owner_id", "createdAt", "updatedAt") SELECT "id", "preferredLanguage", "timezone", "address", "consents", "lastActiveAccount_Id", "lastActiveWorkspace_Id", "uiPreferences", "onboardingChecklist", "owner_id", "createdAt", "updatedAt" FROM `user_profiles`;--> statement-breakpoint
DROP TABLE `user_profiles`;--> statement-breakpoint
ALTER TABLE `__new_user_profiles` RENAME TO `user_profiles`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_profiles_owner_id_ux` ON `user_profiles` (`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_workspace_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`autoLoopEnabled` integer DEFAULT false NOT NULL,
	`loopIntervalDays` integer DEFAULT 3 NOT NULL,
	`minImpressionsToCompare` integer DEFAULT 1000 NOT NULL,
	`comparisonWeights` text DEFAULT '{"ctr":0.7,"impressions":0.3}' NOT NULL,
	`maxBudget` real,
	`requireCreativeApproval` integer DEFAULT true NOT NULL,
	`requireLandingApproval` integer DEFAULT false NOT NULL,
	`defaultIncludeGoogleTag` integer DEFAULT true NOT NULL,
	`defaultIncludeFacebookPixel` integer DEFAULT true NOT NULL,
	`avgOrderValue` real,
	`extra` text DEFAULT '{}' NOT NULL,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workspace_settings`("id", "autoLoopEnabled", "loopIntervalDays", "minImpressionsToCompare", "comparisonWeights", "maxBudget", "requireCreativeApproval", "requireLandingApproval", "defaultIncludeGoogleTag", "defaultIncludeFacebookPixel", "avgOrderValue", "extra", "workspace_id", "account_id", "createdAt", "updatedAt") SELECT "id", "autoLoopEnabled", "loopIntervalDays", "minImpressionsToCompare", "comparisonWeights", "maxBudget", "requireCreativeApproval", "requireLandingApproval", "defaultIncludeGoogleTag", "defaultIncludeFacebookPixel", "avgOrderValue", "extra", "workspace_id", "account_id", "createdAt", "updatedAt" FROM `workspace_settings`;--> statement-breakpoint
DROP TABLE `workspace_settings`;--> statement-breakpoint
ALTER TABLE `__new_workspace_settings` RENAME TO `workspace_settings`;--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_settings_workspace_id_ux` ON `workspace_settings` (`workspace_id`);