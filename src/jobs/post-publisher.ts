// Organic post publishing for scheduled_posts rows. Meta Pages (feed/photos)
// ported; other platforms report honestly. Port of lib/post-publisher.js.
import { and, eq, isNull, lte, or } from "drizzle-orm";
import {
  adPlatforms,
  mediaAssets,
  platformConnections,
  postMedia,
  posts,
  scheduledPosts,
} from "../db/schema/index.js";
import type { Db } from "../db/index.js";
import { getValidAccessToken } from "../lib/connections.js";
import { pausedAccountIds, type JobCtx } from "./index.js";

const now = () => new Date();
const GRAPH = "https://graph.facebook.com/v22.0";

async function graph(method: string, path: string, params?: Record<string, any>): Promise<any> {
  const r = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(params),
    signal: AbortSignal.timeout(60000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || (d as any).error)
    throw new Error((d as any).error?.error_user_msg || (d as any).error?.message || `HTTP ${r.status}`);
  return d;
}

const PUBLISHERS: Record<
  string,
  (args: {
    accessToken: string;
    connection: Record<string, any>;
    post: Record<string, any>;
    mediaUrls: string[];
  }) => Promise<{ externalPostId?: string }>
> = {
  async meta({ accessToken, connection, post, mediaUrls }) {
    const pageId = connection.meta?.selectedPageId || connection.meta?.pages?.[0]?.id;
    if (!pageId) throw new Error("Pick a Facebook Page in Connections before publishing");
    const pages = (
      await graph("GET", `me/accounts?fields=id,access_token&access_token=${encodeURIComponent(accessToken)}`)
    ).data || [];
    const pageToken = pages.find((p: any) => p.id === pageId)?.access_token;
    if (!pageToken) throw new Error("No publish permission for the selected Facebook Page — reconnect Meta");
    const message = [post.headline, post.body, post.destinationUrl].filter(Boolean).join("\n\n");
    const d = mediaUrls.length
      ? await graph("POST", `${pageId}/photos`, { url: mediaUrls[0], message, access_token: pageToken })
      : await graph("POST", `${pageId}/feed`, { message, access_token: pageToken });
    return { externalPostId: d.post_id || d.id };
  },
};

async function mediaUrlsFor(db: Db, post: Record<string, any>): Promise<string[]> {
  const fromFields: string[] = post.fieldValues?.mediaUrls || [];
  if (fromFields.length) return fromFields.filter(Boolean);
  const links = await db
    .select({ mediaId: postMedia.media_id })
    .from(postMedia)
    .where(eq(postMedia.post_id, post.id));
  if (!links.length) return [];
  const assets = await db
    .select({ url: mediaAssets.url })
    .from(mediaAssets)
    .where(
      // drizzle: build an OR over the ids
      or(...links.map((l) => eq(mediaAssets.id, l.mediaId))),
    );
  return assets.map((a) => a.url).filter(Boolean);
}

/** Minutes until the next retry for a failed publish (exponential backoff, capped at 60). */
export function retryDelayMinutes(attempt: number): number {
  return Math.min(60, 5 * 2 ** attempt);
}

export async function publishScheduledPost(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
  id: string,
): Promise<{ published?: boolean; skipped?: boolean; externalPostId?: string; error?: string; retryAt?: string | null }> {
  const sp = (
    await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id)).limit(1)
  )[0] as unknown as Record<string, any> | undefined;
  if (!sp || !["queued", "failed"].includes(sp.status)) return { skipped: true };
  const attempt = (sp.attempts || 0) + 1;
  await db
    .update(scheduledPosts)
    .set({ status: "publishing", attempts: attempt, lastAttemptAt: now(), updatedAt: now() })
    .where(eq(scheduledPosts.id, id));
  try {
    const post = (
      await db.select().from(posts).where(eq(posts.id, sp.post_id)).limit(1)
    )[0] as unknown as Record<string, any> | undefined;
    if (!post) throw Object.assign(new Error("Post no longer exists"), { fatal: true });
    const platform = sp.platform_id
      ? ((await db.select().from(adPlatforms).where(eq(adPlatforms.id, sp.platform_id)).limit(1))[0] as unknown as
          | Record<string, any>
          | undefined)
      : undefined;
    const code = platform?.code;
    const pub = code ? PUBLISHERS[code] : undefined;
    if (!pub)
      throw Object.assign(
        new Error(`${platform?.name || code || "This platform"} organic publishing is not available yet in this build`),
        { fatal: true },
      );
    let connectionId = sp.connection_id;
    if (!connectionId) {
      const c = (
        await db
          .select({ id: platformConnections.id })
          .from(platformConnections)
          .where(
            and(
              eq(platformConnections.workspace_id, sp.workspace_id),
              eq(platformConnections.platform_id, sp.platform_id),
            ),
          )
          .limit(1)
      )[0];
      connectionId = c?.id;
    }
    if (!connectionId) throw Object.assign(new Error(`Not connected to ${platform?.name || "platform"}`), { fatal: true });
    const { accessToken, connection } = await getValidAccessToken(
      db,
      secretKey,
      sp.workspace_id,
      code,
      env,
    );
    void connectionId;
    const mediaUrls = await mediaUrlsFor(db, post);
    const r = await pub({ accessToken, connection, post, mediaUrls });
    await db
      .update(scheduledPosts)
      .set({
        status: "published",
        publishedAt: now(),
        externalPostId: r.externalPostId || null,
        errorMessage: null,
        lastError: {},
        updatedAt: now(),
      })
      .where(eq(scheduledPosts.id, id));
    await db
      .update(posts)
      .set({ status: "published", publishedAt: now(), updatedAt: now() })
      .where(eq(posts.id, post.id));
    return { published: true, externalPostId: r.externalPostId };
  } catch (e) {
    const fatal = (e as any).fatal || attempt >= 3;
    const nextRetryAt = fatal ? null : new Date(Date.now() + retryDelayMinutes(attempt) * 60000);
    await db
      .update(scheduledPosts)
      .set({
        status: fatal ? "failed" : "queued",
        errorMessage: (e as Error).message,
        lastError: { message: (e as Error).message, attempt, at: now().toISOString() },
        ...(fatal ? { nextRetryAt: null } : { nextRetryAt: nextRetryAt as Date }),
        updatedAt: now(),
      })
      .where(eq(scheduledPosts.id, id));
    if (fatal && sp.post_id) {
      await db
        .update(posts)
        .set({ status: "failed", updatedAt: now() })
        .where(eq(posts.id, sp.post_id))
        .catch(() => {});
    }
    return { published: false, error: (e as Error).message, retryAt: nextRetryAt?.toISOString() ?? null };
  }
}

/** Publish everything that is due (called by the schedule and by "publish now"). */
export async function publishDue(
  db: Db,
  env: Record<string, string | undefined>,
  secretKey: string,
): Promise<{ due: number; published: number; failed: number; pausedSkipped: number }> {
  const t = now();
  const due = await db
    .select({ id: scheduledPosts.id, accountId: scheduledPosts.account_id })
    .from(scheduledPosts)
    .where(
      and(
        eq(scheduledPosts.status, "queued"),
        lte(scheduledPosts.scheduledAt, t),
        or(isNull(scheduledPosts.nextRetryAt), lte(scheduledPosts.nextRetryAt, t)),
      ),
    )
    .limit(50);
  // A suspended or closed account must not keep publishing — that spends the
  // customer's budget after we told them the account is paused. Their posts
  // stay queued for later.
  const paused = await pausedAccountIds(db);
  const runnable = paused.size ? due.filter((r) => !paused.has(r.accountId)) : due;
  let published = 0;
  let failed = 0;
  for (const r of runnable) {
    const x = await publishScheduledPost(db, env, secretKey, r.id);
    if (x.published) published++;
    else if (!x.skipped) failed++;
  }
  return { due: runnable.length, published, failed, pausedSkipped: due.length - runnable.length };
}

// The cron entry point. Runs every minute; recording an empty tick would flood
// the history, so only a run that actually published anything is kept.
// (The busy-guard is best-effort: Workers isolates don't share module state
// reliably, but a 1-minute cadence makes overlap unlikely.)
let busy = false;
export async function runPostPublisher(ctx: JobCtx): Promise<Record<string, any>> {
  if (busy) return { skipped: true, reason: "previous tick still running" };
  busy = true;
  try {
    return await publishDue(ctx.db, ctx.env, ctx.secretKey);
  } finally {
    busy = false;
  }
}
