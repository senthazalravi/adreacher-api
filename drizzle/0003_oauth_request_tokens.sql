CREATE TABLE `oauth_request_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`state` text,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_request_tokens_expiresAt_idx` ON `oauth_request_tokens` (`expiresAt`);
