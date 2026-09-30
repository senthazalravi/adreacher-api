# adreacher-api

Cloudflare-native backend for AdReacher. Workers + Hono + D1 (Drizzle) + R2. No Baasix.

## Stack

- **Runtime:** Cloudflare Workers (Hono)
- **Database:** D1 (`adreacher`) via Drizzle ORM
- **Files:** R2 (`adreacher-assets` bucket)
- **Migrations:** drizzle-kit → `drizzle/`

## Layout

- `src/index.ts` — Hono app, router mounting
- `src/routes/items.ts` — generic `/items/:collection` CRUD (the frontend's data layer)
- `src/routes/files.ts` — `POST /files`, `GET /assets/:fileId`, `DELETE /files/:fileId`
- `src/lib/filter.ts` — filter-DSL compiler (`eq/ne/icontains/arraycontains/jsonbContains/AND/OR`)
- `src/lib/query.ts` — list query helpers (fields, sort, pagination, aggregate)
- `src/db/schema/` — Drizzle table definitions per domain
- `src/db/registry.ts` — collection name → table map

## Develop

```bash
npm install
npm run db:generate   # regenerate migrations from schema
npm run db:migrate:local
npm test
npm run dev
```

## Deploy

## Deploy

```bash
npx wrangler d1 migrations apply adreacher --remote
npx wrangler deploy
```

Required worker secrets: `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`RESEND_API_KEY`, `EMAIL_FROM` (transactional email via Resend; see Phase 2 notes).
Note: verify the sending domain in the Resend dashboard before production sends.

## Migrations note

`drizzle/*.sql` is the source of truth for applying migrations. The large
`drizzle/meta/*snapshot.json` files are maintained in the primary checkout
and not all are committed (tooling file-size limits) — generate new
migrations there with `npm run db:generate`.
