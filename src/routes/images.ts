import { and, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { images, posts, postTargets, topics } from "../db/schema";
import type { AppEnv } from "../env";
import { suggestCaptions, suggestFanPosts } from "../jobs/ai-content";
import { syncDriveImages, syncReelVideos } from "../jobs/drive-sync";
import { clearFutureAuto, planAutoPosts, refreshAutoCaptions } from "../jobs/planner";
import { fail, idParam, readJson } from "../lib/http";
import { appTimeZone } from "../lib/settings";
import { PublishFailure } from "../platforms/errors";

export const MAX_CAPTIONS = 10;
const texts = z.array(z.string().trim().max(2000)).max(MAX_CAPTIONS);
/** Duyệt gợi ý AI = chuyển chữ từ `suggestions` sang `captions` (client gửi cả hai). */
const patchBody = z.object({
  captions: texts.optional(),
  suggestions: texts.optional(),
  topicId: z.int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});
const textBody = z.object({ text: z.string().trim().min(1).max(2000), topicId: z.int().positive().nullable().default(null) });

/** Lỗi Drive / Claude (chưa cấu hình, hết hạn mức...) trả về cho người dùng thay vì 500. */
async function friendly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PublishFailure) throw fail(400, err.message);
    throw err;
  }
}

async function assertTopic(db: ReturnType<typeof getDb>, topicId: number | null | undefined) {
  if (topicId && !(await db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId)).get())) throw fail(400, "không có chủ đề này");
}

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

/** Đồng bộ ngay thư mục post-fb (ảnh), hoặc các thư mục Reels của các Page (?kind=reel). Cron cũng tự đồng bộ mỗi giờ. */
imageRoutes.post("/sync", async (c) => {
  const db = getDb(c.env);
  const sync = c.req.query("kind") === "reel" ? syncReelVideos : syncDriveImages;
  try {
    return c.json(await sync(db, c.env, Date.now()));
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
  const suggestions = body.suggestions?.filter(Boolean);
  await assertTopic(db, body.topicId);
  const before = await db.select({ topicId: images.topicId }).from(images).where(eq(images.id, idParam(c))).get();
  const [img] = await db
    .update(images)
    .set({
      ...(captions ? { captions } : {}),
      ...(suggestions ? { suggestions } : {}),
      ...(body.topicId !== undefined ? { topicId: body.topicId } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      updatedAt: now,
    })
    .where(eq(images.id, idParam(c)))
    .returning();
  if (!img) throw fail(404, "không tìm thấy ảnh");
  // Đổi chủ đề: bài tự động chưa đi của media này được lập lại theo chủ đề mới.
  if (!img.enabled || (body.topicId !== undefined && body.topicId !== before?.topicId)) await clearFutureAuto(db, { imageKey: img.driveFileId });
  else if (captions) await refreshAutoCaptions(db, img.driveFileId, captions, now);
  const plan = await planAutoPosts(db, now, await appTimeZone(db));
  return c.json({ image: img, plan: { created: plan.created, shortages: plan.shortages.length } });
});

/** AI viết thêm 3 caption gợi ý cho ảnh/video này (chờ duyệt). */
imageRoutes.post("/:id/suggest", async (c) => {
  const db = getDb(c.env);
  return c.json(await friendly(() => suggestCaptions(db, c.env, idParam(c), Date.now())));
});

/** AI viết 4 bài chữ hỏi fan, vào kho bài chữ chờ duyệt. */
imageRoutes.post("/fan-posts", async (c) => {
  const db = getDb(c.env);
  return c.json({ created: await friendly(() => suggestFanPosts(db, c.env, Date.now())) });
});

/** Bạn tự viết một bài chữ (đã duyệt sẵn). */
imageRoutes.post("/text", async (c) => {
  const db = getDb(c.env);
  const body = await readJson(c, textBody);
  await assertTopic(db, body.topicId);
  const now = Date.now();
  const [img] = await db
    .insert(images)
    .values({ driveFileId: `text-${crypto.randomUUID()}`, name: body.text.slice(0, 80), kind: "text", captions: [body.text], topicId: body.topicId, createdAt: now, updatedAt: now })
    .returning();
  const plan = await planAutoPosts(db, now, await appTimeZone(db));
  return c.json({ image: img, plan: { created: plan.created, shortages: plan.shortages.length } }, 201);
});

/** Xoá bài chữ (ảnh/video thì xoá trên Drive, ở đây chỉ tắt được). Bài tự động chưa đi của nó bị gỡ. */
imageRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const [img] = await db.delete(images).where(and(eq(images.id, idParam(c)), eq(images.kind, "text"))).returning();
  if (!img) throw fail(404, "không có bài chữ này");
  await clearFutureAuto(db, { imageKey: img.driveFileId });
  return c.body(null, 204);
});

/** Dùng nội bộ: số ảnh (không tính video Reels) sẵn sàng: đang bật và có ít nhất 1 caption. */
export async function readyImageCount(db: ReturnType<typeof getDb>) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(images)
    .where(and(eq(images.kind, "image"), eq(images.enabled, true), sql`json_array_length(${images.captions}) > 0`));
  return Number(row?.n ?? 0);
}

