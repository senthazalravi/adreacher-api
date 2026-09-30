import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { files } from "../db/schema/identity.js";
import { HttpError } from "../lib/filter.js";
import { authMiddleware, tenantStatusGuard, authenticate, sessionOf } from "../lib/auth.js";
import { recordUsage } from "../lib/usage.js";
import { getDb } from "../db/index.js";
import type { Env } from "../index.js";

const filesRouter = new Hono<{ Bindings: Env }>();

// Uploads and deletes require a session; serving is public for public files
// (ad platforms fetch creatives by URL) and requires a session otherwise.
filesRouter.use("/files", authMiddleware);
filesRouter.use("/files/*", authMiddleware);
filesRouter.use("/files", tenantStatusGuard);
filesRouter.use("/files/*", tenantStatusGuard);

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

filesRouter.post("/files", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, 'Multipart field "file" is required', "FILE_REQUIRED");
  }
  const titleRaw = form.get("title");
  const folderRaw = form.get("folder");
  const isPublicRaw = form.get("isPublic");

  const folder =
    typeof folderRaw === "string" && folderRaw.trim() !== ""
      ? sanitizeName(folderRaw.trim())
      : "uploads";
  const key = `${folder}/${crypto.randomUUID()}-${sanitizeName(file.name)}`;
  const contentType = file.type || "application/octet-stream";

  await c.env.R2.put(key, file.stream(), { httpMetadata: { contentType } });

  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  const session = sessionOf(c);
  await db.insert(files).values({
    id,
    tenantId: session?.tenantId || null,
    r2Key: key,
    filename: file.name,
    mimeType: file.type || null,
    sizeBytes: file.size,
    title: typeof titleRaw === "string" && titleRaw.trim() !== "" ? titleRaw.trim() : file.name,
    isPublic: isPublicRaw === "true" || isPublicRaw === "1",
    folder,
    createdAt: new Date(),
  });

  // Storage metering: running byte total per account (deletes decrement).
  if (session?.tenantId && file.size > 0) {
    await recordUsage(getDb(c.env.DB), {
      accountId: session.tenantId,
      metricKey: "storage_bytes",
      n: file.size,
    }).catch(() => {});
  }

  // The FE expects { data: <fileId string> }.
  return c.json({ data: id });
});

filesRouter.get("/assets/:fileId", async (c) => {
  // TODO(phase-5): image transforms (pre-generated sizes or transform worker).
  // Transform params (w, h, fit, q, ...) are accepted but the original is served for now.
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(files).where(eq(files.id, c.req.param("fileId"))).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: { code: "NOT_FOUND" } }, 404);

  // Public files serve to anyone (ad platforms fetch by URL); private files
  // require a session.
  if (!row.isPublic) {
    try {
      await authenticate(c);
    } catch {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }
  }

  const obj = await c.env.R2.get(row.r2Key);
  if (!obj) return c.json({ error: { code: "NOT_FOUND" } }, 404);

  const headers = new Headers();
  headers.set("Content-Type", row.mimeType || obj.httpMetadata?.contentType || "application/octet-stream");
  if (typeof obj.size === "number") headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
});

filesRouter.delete("/files/:fileId", async (c) => {
  const db = drizzle(c.env.DB);
  const fileId = c.req.param("fileId");
  const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: { code: "NOT_FOUND" } }, 404);

  await c.env.R2.delete(row.r2Key);
  await db.delete(files).where(eq(files.id, fileId));

  const session = sessionOf(c);
  if (session?.tenantId && Number(row.sizeBytes || 0) > 0) {
    await recordUsage(getDb(c.env.DB), {
      accountId: session.tenantId,
      metricKey: "storage_bytes",
      n: -Number(row.sizeBytes),
    }).catch(() => {});
  }
  return c.json({ data: { id: fileId, deleted: true } });
});

export default filesRouter;
