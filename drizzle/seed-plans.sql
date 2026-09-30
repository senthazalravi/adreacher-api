-- Trial plan seed (idempotent). Apply with:
--   wrangler d1 execute adreacher --remote --file drizzle/seed-plans.sql
-- Mirrors seedPlans() in src/db/seed.ts — the plan accounts without a
-- subscription fall back to (see src/lib/limits.ts).
INSERT INTO `subscription_plans`
  (`id`, `slug`, `name`, `audience`, `price`, `currency`, `billingInterval`, `trialDays`, `entitlements`, `isActive`, `displayOrder`, `createdAt`, `updatedAt`)
VALUES
  ('b1e8f2a4-9c3d-4f7e-8a1b-5d6e7f8a9b0c', 'trial', 'Trial', 'both', 0, 'SEK', 'month', 14,
   '{"workspaces":3,"aiGenerations":100,"brandCrawlsPerMonth":20,"scheduledPostsPerMonth":30,"activeCampaigns":5,"platformConnections":5,"templatesLimit":10,"teamSeats":3,"storageMb":1024}',
   1, 0, unixepoch(), unixepoch())
ON CONFLICT(`slug`) DO NOTHING;
