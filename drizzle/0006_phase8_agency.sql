-- Phase 8: agency client businesses, workspace→client link, invite lifecycle columns.
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`agencyTenantId` text NOT NULL,
	`name` text NOT NULL,
	`orgNumber` text,
	`contactPerson` text,
	`contactEmail` text,
	`contactPhone` text,
	`contactWhatsapp` text,
	`websiteUrl` text,
	`country` text,
	`currency` text DEFAULT 'SEK',
	`notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`features` text DEFAULT '{}',
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`deletedAt` integer
);
--> statement-breakpoint
CREATE INDEX `clients_agency_tenant_idx` ON `clients` (`agencyTenantId`);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD COLUMN `client_id` text;
--> statement-breakpoint
ALTER TABLE `invites` ADD COLUMN `status` text DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE `invites` ADD COLUMN `invitedBy` text;
--> statement-breakpoint
ALTER TABLE `invites` ADD COLUMN `workspaceIds` text;
