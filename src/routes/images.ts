import { and, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { images, posts, postTargets } from "../db/schema";
import type { AppEnv } from "../env";
import { syncDriveImages } from "../jobs/drive-sync";
import { clearFutureAuto, planAutoPosts, refreshAutoCaptions } from "../jobs/planner";
import { fail, idParam, readJson } from "../lib/http";
import { appTimeZone } from "../lib/settings";
import { PublishFailure } from "../platforms/errors";

export const MAX_CAPTIONS = 10;
const patchBody = z.object({
  captions: z.array(z.string().trim().max(2000)).max(MAX_CAPTIONS).optional(),
  enabled: z.boolean().optional(),
});

export const imageRoutes = new Hono<AppEnv>();

/** Kho ảnh kèm lần dùng gần nhất và lần dùng sắp tới (mọi Page), để biết ảnh nào đang được xoay vòng. */
imageRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const [list, usage] = await Promise.all([
    db.select().from(images).orderBy(desc(images.createdAt)),
    db
      .select({
        imageKey: posts.imageKey,
        lastUsedAt: sql<number | null>`max(CASE WHEN ${posts.scheduledAt} <= ${now} THEN ${posts.scheduledAt} END)`,
        nextUseAt: sql<number | null>`min(CASE WHEN ${posts.scheduledAt} > ${now} THEN ${posts.scheduledAt} END)`,
      })
      .from(posts)
      .innerJoin(postTargets, eq(postTargets.postId, posts.id))
      .where(and(isNotNull(posts.imageKey), notInArray(postTargets.status, ["failed"])))
      .groupBy(posts.imageKey),
  ]);
  const byKey = new Map(usage.map((u) => [u.imageKey, u]));
  return c.json(list.map((img) => ({ ...img, lastUsedAt: byKey.get(img.driveFileId)?.lastUsedAt ?? null, nextUseAt: byKey.get(img.driveFileId)?.nextUseAt ?? null })));
});

/** Đồng bộ ngay với thư mục post-fb trên Drive (cron cũng tự đồng bộ mỗi giờ). */
imageRoutes.post("/sync", async (c) => {
  const db = getDb(c.env);
  try {
    return c.json(await syncDriveImages(db, c.env, Date.now()));
  } catch (err) {
    if (err instanceof PublishFailure) throw fail(400, `Google Drive: ${err.message}`);
    throw err;
  }
});

/** Sửa caption (tối đa 10) hoặc bật/tắt ảnh. Bài tự động chưa đi được cập nhật theo, khung giờ trống được lấp lại. */
imageRoutes.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const body = await readJson(c, patchBody);
  const now = Date.now();
  const captions = body.captions?.filter(Boolean);
  const [img] = await db
    .update(images)
    .set({ ...(captions ? { captions } : {}), ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), updatedAt: now })
    .where(eq(images.id, idParam(c)))
    .returning();
  if (!img) throw fail(404, "không tìm thấy ảnh");
  if (!img.enabled) await clearFutureAuto(db, { imageKey: img.driveFileId });
  else if (captions) await refreshAutoCaptions(db, img.driveFileId, captions, now);
  const plan = await planAutoPosts(db, now, await appTimeZone(db));
  return c.json({ image: img, plan: { created: plan.created, shortages: plan.shortages.length } });
});

/** Dùng nội bộ: số ảnh sẵn sàng (đang bật và có ít nhất 1 caption). */
export async function readyImageCount(db: ReturnType<typeof getDb>) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(images)
    .where(and(eq(images.enabled, true), sql`json_array_length(${images.captions}) > 0`));
  return Number(row?.n ?? 0);
}

