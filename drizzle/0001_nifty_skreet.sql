CREATE TABLE `user_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text,
	`email` text NOT NULL,
	`tenantId` text,
	`type` text NOT NULL,
	`tokenHash` text NOT NULL,
	`data` text,
	`expiresAt` integer NOT NULL,
	`usedAt` integer,
	`createdAt` integer DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_tokens_tokenHash_unique` ON `user_tokens` (`tokenHash`);--> statement-breakpoint
ALTER TABLE `tenants` ADD `type` text DEFAULT 'client' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `ownerId` text;--> statement-breakpoint
ALTER TABLE `users` ADD `activeWorkspaceId` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totpSecret` text;--> statement-breakpoint
ALTER TABLE `users` ADD `platformAdmin` integer DEFAULT false NOT NULL;