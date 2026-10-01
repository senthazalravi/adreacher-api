CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`startedAt` integer NOT NULL,
	`finishedAt` integer,
	`durationMs` integer,
	`result` text,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_name_started_idx` ON `job_runs` (`name`,`startedAt`);
