-- AdReacher ad_platforms catalog seed (idempotent).
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('704aae1d-6a3a-4a08-93b3-cd77c98843f2', 'google_ads', 'Google Ads', 'ads', 1, 'Search, Performance Max and Demand Gen campaigns + analytics', '{"sales":"Sales","leads":"Leads","website_traffic":"Website traffic","app_promotion":"App promotion","awareness":"Awareness and consideration","local_store_visits":"Local store visits"}', '{"daily":5,"recommendedDaily":20,"supportsLifetimeBudget":false}', 'micros', 10, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('fd9f9e3b-75fe-42f2-8f6f-6fe911f68db9', 'meta', 'Meta', 'both', 1, 'Automated ads on Facebook and Instagram + analytics', '{"awareness":"Awareness","traffic":"Traffic","engagement":"Engagement","leads":"Leads","app_promotion":"App promotion","sales":"Sales"}', '{"daily":1,"adGroup":1,"recommendedDaily":10,"supportsLifetimeBudget":true}', 'cents', 11, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('8659d838-25fb-4d31-9a3e-cb6585b264c1', 'tiktok', 'TikTok', 'both', 1, 'Video campaigns on TikTok + analytics', '{"reach":"Reach","traffic":"Traffic","video_views":"Video views","community_interaction":"Community interaction","app_promotion":"App promotion","lead_generation":"Lead generation","website_conversions":"Website conversions"}', '{"daily":20,"adGroup":20,"recommendedDaily":50,"supportsLifetimeBudget":true}', 'cents', 12, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('440d9602-59ba-4643-9f1a-444646c540c4', 'x', 'X', 'both', 1, 'Campaigns + analytics on X', '{"reach":"Reach","video_views":"Video views","website_conversions":"Website conversions","app_installs":"App installs","followers":"Followers","engagements":"Engagements"}', '{"daily":10,"recommendedDaily":30,"supportsLifetimeBudget":false}', 'cents', 13, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('0a3ebeca-0171-40a2-93fb-df70fe3d9a4b', 'reddit', 'Reddit', 'both', 1, 'Community-targeted ads + analytics', '{"awareness":"Awareness","traffic":"Traffic","conversions":"Conversions","video_views":"Video views","app_installs":"App installs"}', '{"daily":5,"adGroup":5,"recommendedDaily":20,"supportsLifetimeBudget":true}', 'cents', 14, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('11376613-cf3d-4688-bca6-c66aaf1a5a6e', 'pinterest', 'Pinterest', 'social', 1, 'Shopping pins + audience insights', '{"awareness":"Brand awareness","video_views":"Video views","consideration":"Consideration","conversions":"Conversions","catalog_sales":"Catalog sales"}', '{"daily":5,"adGroup":5,"recommendedDaily":20,"supportsLifetimeBudget":true}', 'cents', 15, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('5977b29b-54ac-4bbf-9d35-ee32f6bca232', 'bing_ads', 'Bing', 'ads', 1, 'Search campaigns on Bing + analytics', '{"sales":"Sales","leads":"Leads","website_traffic":"Website traffic","app_promotion":"App promotion"}', '{"daily":5,"recommendedDaily":20,"supportsLifetimeBudget":false}', 'cents', 16, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('6d8ff6f4-4b5e-4e25-aca3-0046baa60300', 'openai_ads', 'OpenAI Ads', 'ads', 1, 'Chat-card ads inside ChatGPT', '{"awareness":"Awareness","traffic":"Traffic","conversions":"Conversions"}', '{"daily":10,"recommendedDaily":30,"supportsLifetimeBudget":true}', 'cents', 17, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ad_platforms (id, code, name, kind, isEnabled, unlocksCopy, supportedObjectives, budgetMinimums, currencyUnit, sortOrder, createdAt, updatedAt)
VALUES ('b21e234d-0a68-4e5c-8499-d8244b156e4f', 'youtube_ads', 'YouTube Ads', 'ads', 0, 'Video campaigns via Google Ads', '{"awareness":"Brand awareness and reach","consideration":"Product and brand consideration","action":"Drive action"}', '{"daily":10,"recommendedDaily":30,"supportsLifetimeBudget":false}', 'micros', 18, strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(code) DO NOTHING;
