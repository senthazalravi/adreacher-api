CREATE TABLE `ad_platforms` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_platforms_code_unique` ON `ad_platforms` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `ad_platforms_code_ux` ON `ad_platforms` (`code`);--> statement-breakpoint
CREATE TABLE `brand_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceUrl` text,
	`business` text DEFAULT '{}' NOT NULL,
	`branding` text DEFAULT '{}' NOT NULL,
	`toneOfVoice` text DEFAULT [],
	`audience` text DEFAULT '{}',
	`keywords` text DEFAULT [],
	`suggestedCampaigns` text DEFAULT [],
	`scrapeStatus` text DEFAULT 'pending' NOT NULL,
	`scrapeError` text,
	`lastScrapedAt` integer,
	`onboardingCompletedAt` integer,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brand_scrape_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`sourceUrl` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`steps` text DEFAULT [] NOT NULL,
	`result` text DEFAULT '{}',
	`error` text,
	`claimedByWorkspace_Id` text,
	`claimedAt` integer,
	`expiresAt` integer,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_scrape_drafts_token_unique` ON `brand_scrape_drafts` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `brand_scrape_drafts_token_ux` ON `brand_scrape_drafts` (`token`);--> statement-breakpoint
CREATE TABLE `platform_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text,
	`clientSecret` text,
	`developerToken` text,
	`authorizeUrl` text,
	`tokenUrl` text,
	`scopes` text DEFAULT [],
	`apiVersion` text,
	`extra` text DEFAULT '{}' NOT NULL,
	`isConfigured` integer DEFAULT false NOT NULL,
	`platform_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_configs_platform_id_ux` ON `platform_configs` (`platform_id`);--> statement-breakpoint
CREATE TABLE `platform_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'not_connected' NOT NULL,
	`externalAccountId` text,
	`externalAccountName` text,
	`accessToken` text,
	`refreshToken` text,
	`tokenExpiresAt` integer,
	`scopes` text DEFAULT [],
	`currency` text,
	`setupIssues` text DEFAULT [] NOT NULL,
	`lastSyncedAt` integer,
	`lastError` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`workspace_id` text,
	`platform_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_connections_workspace_id_platform_id_ux` ON `platform_connections` (`workspace_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `campaign_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`occurredAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`campaign_id` text,
	`actor_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `campaign_iterations` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_iterations_campaign_id_iterationNumber_ux` ON `campaign_iterations` (`campaign_id`,`iterationNumber`);--> statement-breakpoint
CREATE TABLE `campaign_platforms` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_platforms_campaign_id_platform_id_ux` ON `campaign_platforms` (`campaign_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `campaign_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`objective` text,
	`definition` text DEFAULT '{}' NOT NULL,
	`isGallery` integer DEFAULT false NOT NULL,
	`formats` text DEFAULT [],
	`usageCount` integer DEFAULT 0 NOT NULL,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE TABLE `campaign_analytics` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_analytics_campaign_id_platform_id_date_hour_ux` ON `campaign_analytics` (`campaign_id`,`platform_id`,`date`,`hour`);--> statement-breakpoint
CREATE TABLE `campaign_landing_pages` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_landing_pages_slug_ux` ON `campaign_landing_pages` (`slug`);--> statement-breakpoint
CREATE TABLE `campaign_posts` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_posts_campaign_id_post_id_platform_id_ux` ON `campaign_posts` (`campaign_id`,`post_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `creatives` (
	`id` text PRIMARY KEY NOT NULL,
	`headline` text,
	`body` text,
	`shotType` text,
	`subject` text,
	`aspectRatios` text DEFAULT [],
	`placements` text DEFAULT [],
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE TABLE `media_assets` (
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
	`tags` text DEFAULT [],
	`metadata` text DEFAULT '{}' NOT NULL,
	`workspace_id` text,
	`uploadedBy_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE TABLE `platform_post_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`isRequired` integer DEFAULT false NOT NULL,
	`labelOverride` text,
	`placeholder` text,
	`helpText` text,
	`validationOverride` text DEFAULT '{}',
	`optionsOverride` text DEFAULT [],
	`displayOrder` integer DEFAULT 0 NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`platform_id` text,
	`field_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_post_fields_platform_id_field_id_ux` ON `platform_post_fields` (`platform_id`,`field_id`);--> statement-breakpoint
CREATE TABLE `post_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`fieldType` text DEFAULT 'text' NOT NULL,
	`scope` text DEFAULT 'post' NOT NULL,
	`defaultValidation` text DEFAULT '{}' NOT NULL,
	`options` text DEFAULT [] NOT NULL,
	`description` text,
	`displayOrder` integer DEFAULT 0 NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_fields_name_unique` ON `post_fields` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_fields_name_ux` ON `post_fields` (`name`);--> statement-breakpoint
CREATE TABLE `post_media` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`media_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_media_post_id_media_id_ux` ON `post_media` (`post_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `posts` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE TABLE `scheduled_posts` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `website_scraped_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`url` text NOT NULL,
	`title` text,
	`metaDescription` text,
	`metaKeywords` text DEFAULT [],
	`headings` text DEFAULT [] NOT NULL,
	`bodyText` text,
	`ctaButtons` text DEFAULT [],
	`images` text DEFAULT [] NOT NULL,
	`brandColors` text DEFAULT [],
	`brandName` text,
	`fonts` text DEFAULT [],
	`extractedAt` integer,
	`draft_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agency_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`engagementStartedAt` integer,
	`engagementEndedAt` integer,
	`notes` text,
	`agency_id` text,
	`client_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agency_clients_agency_id_client_id_ux` ON `agency_clients` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `agency_staff_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`assignedAt` integer DEFAULT CURRENT_TIMESTAMP,
	`status` text DEFAULT 'active' NOT NULL,
	`agency_id` text,
	`staff_id` text,
	`workspace_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agency_staff_workspaces_agency_id_staff_id_workspace_id_ux` ON `agency_staff_workspaces` (`agency_id`,`staff_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`invitedAt` integer,
	`acceptedAt` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`workspace_id` text,
	`member_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspace_id_member_id_ux` ON `workspace_members` (`workspace_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenantId` text,
	`userId` text,
	`action` text NOT NULL,
	`entityType` text,
	`entityId` text,
	`meta` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`tenantId` text,
	`r2Key` text NOT NULL,
	`filename` text NOT NULL,
	`mimeType` text,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`title` text,
	`isPublic` integer DEFAULT false NOT NULL,
	`folder` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_r2Key_unique` ON `files` (`r2Key`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`tenantId` text NOT NULL,
	`role` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`acceptedAt` integer,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenantId` text,
	`userId` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`data` text,
	`seenAt` integer,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`planSlug` text,
	`billingEmail` text,
	`contactPerson` text,
	`phones` text,
	`address` text,
	`country` text,
	`orgNumber` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`passwordHash` text,
	`firstName` text,
	`lastName` text,
	`tenantId` text,
	`emailVerified` integer DEFAULT false NOT NULL,
	`twoFactorEnabled` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `ai_settings` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`stripePublishableKey` text,
	`stripeSecretKey` text,
	`stripeWebhookSecret` text,
	`defaultCurrency` text DEFAULT 'SEK' NOT NULL,
	`trialDays` integer DEFAULT 14 NOT NULL,
	`testMode` integer DEFAULT true NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dashboard_metric_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`platformCode` text DEFAULT 'all' NOT NULL,
	`metricKeys` text DEFAULT [] NOT NULL,
	`owner_id` text,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_metric_prefs_owner_id_workspace_id_platformCode_ux` ON `dashboard_metric_prefs` (`owner_id`,`workspace_id`,`platformCode`);--> statement-breakpoint
CREATE TABLE `deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'account' NOT NULL,
	`targetId` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requestedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`scheduledDeletionDate` integer,
	`completedAt` integer,
	`notes` text,
	`requestedBy_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`inAppEnabled` integer DEFAULT true NOT NULL,
	`toastEnabled` integer DEFAULT true NOT NULL,
	`emailEnabled` integer DEFAULT true NOT NULL,
	`categories` text DEFAULT '{}' NOT NULL,
	`digestFrequency` text DEFAULT 'instant' NOT NULL,
	`recipient_id` text,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_recipient_id_ux` ON `notification_preferences` (`recipient_id`);--> statement-breakpoint
CREATE TABLE `subscription_plans` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_plans_slug_unique` ON `subscription_plans` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_plans_slug_ux` ON `subscription_plans` (`slug`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`id` text PRIMARY KEY NOT NULL,
	`metricKey` text NOT NULL,
	`periodStart` integer NOT NULL,
	`periodEnd` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`limitValue` integer,
	`workspace_id` text,
	`account_id` text NOT NULL,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_profiles_owner_id_ux` ON `user_profiles` (`owner_id`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
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
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_settings_workspace_id_ux` ON `workspace_settings` (`workspace_id`);