import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { files } from "../db/schema/identity.js";
import { HttpError } from "../lib/filter.js";
import type { Env } from "../index.js";

const filesRouter = new Hono<{ Bindings: Env }>();

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
  await db.insert(files).values({
    id,
    r2Key: key,
    filename: file.name,
    mimeType: file.type || null,
    sizeBytes: file.size,
    title: typeof titleRaw === "string" && titleRaw.trim() !== "" ? titleRaw.trim() : file.name,
    isPublic: isPublicRaw === "true" || isPublicRaw === "1",
    folder,
    createdAt: new Date(),
  });

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
  return c.json({ data: { id: fileId, deleted: true } });
});

export default filesRouter;
