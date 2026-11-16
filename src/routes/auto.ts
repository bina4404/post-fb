import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { accounts, images, mediaKinds, pageTimes, topics } from "../db/schema";
import type { AppEnv } from "../env";
import { syncReelVideos } from "../jobs/drive-sync";
import { clearFutureAuto, measuredViews, planAutoPosts, upcomingAutoCounts, type PlanResult } from "../jobs/planner";
import { EVERY_DAY, median, minImagesNeeded, topicWeights, type MediaKind } from "../lib/autoplan";
import { driveAccessToken, withDistinctNames } from "../lib/accounts";
import { fail, idParam, readJson } from "../lib/http";
import { log } from "../lib/log";
import { PAGE_DAILY_CAP, PAGE_MIN_GAP_MS } from "../lib/pacing";
import { appTimeZone } from "../lib/settings";
import { driveFileId, listFolders } from "../platforms/drive";
import { PublishFailure } from "../platforms/errors";
import { readyImageCount } from "./images";

const MIN_GAP_MINUTES = PAGE_MIN_GAP_MS / 60_000;

const minute = z.int().min(0).max(1439);
const minutes = z.array(minute).max(PAGE_DAILY_CAP);
/** Một giờ đăng: loại bài, các ngày trong tuần (bitmask, bit 0 = Chủ nhật), chủ đề cố định hoặc null = app tự chọn. */
const slot = z.object({
  minuteOfDay: minute,
  kind: z.enum(mediaKinds),
  days: z.int().min(1).max(EVERY_DAY).default(EVERY_DAY),
  topicId: z.int().positive().nullable().default(null),
});
type Slot = z.infer<typeof slot>;
const everyDay = (kind: MediaKind) => (minuteOfDay: number): Slot => ({ minuteOfDay, kind, days: EVERY_DAY, topicId: null });

/**
 * Giờ đăng của một Page. `slots` là lịch theo tuần; `times`/`reelTimes` là cách viết cũ (ảnh/Reels mọi ngày, app tự chọn chủ đề).
 * Mọi giờ xét chung, bất kể ngày: không trùng phút, tối đa PAGE_DAILY_CAP giờ, cách nhau ≥ PAGE_MIN_GAP (tính cả qua nửa đêm).
 * reelFolder: thư mục video trên Drive (null = bỏ chọn, thiếu = giữ nguyên).
 */
const pageBody = z
  .object({
    autoEnabled: z.boolean(),
    times: minutes.default([]),
    reelTimes: minutes.default([]),
    slots: z.array(slot).max(PAGE_DAILY_CAP).default([]),
    reelFolder: z.object({ id: driveFileId, name: z.string().trim().min(1).max(300) }).nullish(),
  })
  .transform(({ times, reelTimes, slots, ...rest }) => ({ ...rest, slots: [...times.map(everyDay("image")), ...reelTimes.map(everyDay("reel")), ...slots] }))
  .refine((b) => b.slots.length <= PAGE_DAILY_CAP, `tối đa ${PAGE_DAILY_CAP} giờ đăng mỗi ngày (ảnh + Reels + bài chữ)`)
  .refine((b) => new Set(b.slots.map((s) => s.minuteOfDay)).size === b.slots.length, "giờ đăng bị trùng")
  .refine((b) => {
    const sorted = b.slots.map((s) => s.minuteOfDay).sort((x, y) => x - y);
    return sorted.every((m, i) => (i === 0 ? sorted.length < 2 || m + 1440 - sorted.at(-1)! >= MIN_GAP_MINUTES : m - sorted[i - 1]! >= MIN_GAP_MINUTES));
  }, `các giờ đăng phải cách nhau ít nhất ${MIN_GAP_MINUTES} phút`);

/** Số video sẵn sàng (đang bật, có caption) theo thư mục. */
async function readyVideosByFolder(db: ReturnType<typeof getDb>) {
  const rows = await db
    .select({ folderId: images.folderId, n: sql<number>`count(*)` })
    .from(images)
    .where(and(eq(images.kind, "reel"), eq(images.enabled, true), sql`json_array_length(${images.captions}) > 0`))
    .groupBy(images.folderId);
  return new Map(rows.map((r) => [r.folderId, Number(r.n)]));
}

const summary = (plan: PlanResult) => ({ created: plan.created, shortages: plan.shortages.length });

export const autoRoutes = new Hono<AppEnv>();

/** Số liệu từng chủ đề của từng Page: số bài đã đo, trung vị lượt xem, trọng số đang dùng khi app tự chọn chủ đề. */
async function topicStats(db: ReturnType<typeof getDb>, now: number) {
  const stats = await measuredViews(db, now);
  const weight = topicWeights(stats);
  const byKey = new Map<string, number[]>();
  for (const s of stats) byKey.set(`${s.accountId}:${s.topicId}`, [...(byKey.get(`${s.accountId}:${s.topicId}`) ?? []), s.views]);
  return (accountId: number, topicIds: number[]) =>
    topicIds.map((topicId) => {
      const views = byKey.get(`${accountId}:${topicId}`) ?? [];
      return { topicId, measured: views.length, medianViews: views.length ? Math.round(median(views)) : null, weight: Math.round(weight(accountId, topicId) * 100) / 100 };
    });
}

/** Tổng quan đăng tự động: giờ đăng từng Page, số bài sắp tới, số ảnh sẵn sàng, số ảnh tối thiểu và số liệu theo chủ đề. */
autoRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const [pages, times, counts, ready, videos, topicList, statsOf] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        externalId: accounts.externalId,
        autoEnabled: accounts.autoEnabled,
        status: accounts.status,
        reelFolderId: accounts.reelFolderId,
        reelFolderName: accounts.reelFolderName,
      })
      .from(accounts)
      .where(and(eq(accounts.platform, "facebook"), eq(accounts.enabled, true))),
    db.select().from(pageTimes),
    upcomingAutoCounts(db, now),
    readyImageCount(db),
    readyVideosByFolder(db),
    db.select({ id: topics.id }).from(topics),
    topicStats(db, now),
  ]);
  const slotsOf = (id: number) =>
    times
      .filter((t) => t.accountId === id)
      .map((t) => ({ minuteOfDay: t.minuteOfDay, kind: t.kind, days: t.days, topicId: t.topicId }))
      .sort((a, b) => a.minuteOfDay - b.minuteOfDay);
  // times/reelTimes: mọi giờ ảnh/Reels, giữ cho client cũ; lịch đầy đủ ở `slots`.
  const minutesOf = (id: number, kind: MediaKind) => slotsOf(id).filter((s) => s.kind === kind).map((s) => s.minuteOfDay);
  const upcoming = (id: number, kind: MediaKind) => Number(counts.find((n) => n.accountId === id && n.kind === kind)?.n ?? 0);
  const list = withDistinctNames(pages).map((p) => ({
    ...p,
    slots: slotsOf(p.id),
    times: minutesOf(p.id, "image"),
    reelTimes: minutesOf(p.id, "reel"),
    upcoming: upcoming(p.id, "image"),
    upcomingReels: upcoming(p.id, "reel"),
    upcomingText: upcoming(p.id, "text"),
    readyVideos: p.reelFolderId ? (videos.get(p.reelFolderId) ?? 0) : 0,
    topicStats: statsOf(p.id, topicList.map((t) => t.id)),
  }));
  const active = list.filter((p) => p.autoEnabled).map((p) => p.times.length);
  return c.json({ pages: list, readyImages: ready, minImagesNeeded: minImagesNeeded(active), aiEnabled: Boolean(c.env.ANTHROPIC_API_KEY) });
});

/** Lưu giờ đăng và bật/tắt tự động của một Page; lập lại 7 ngày tới cho Page đó theo cài đặt mới. */
autoRoutes.put("/pages/:id", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  const body = await readJson(c, pageBody);
  const topicIds = [...new Set(body.slots.flatMap((s) => (s.topicId ? [s.topicId] : [])))];
  if (topicIds.length) {
    const found = await db.select({ id: topics.id }).from(topics).where(inArray(topics.id, topicIds));
    if (found.length !== topicIds.length) throw fail(400, "có chủ đề không tồn tại");
  }
  const folder = body.reelFolder === undefined ? {} : { reelFolderId: body.reelFolder?.id ?? null, reelFolderName: body.reelFolder?.name ?? null };
  const [page] = await db
    .update(accounts)
    .set({ autoEnabled: body.autoEnabled, ...folder, updatedAt: Date.now() })
    .where(and(eq(accounts.id, id), eq(accounts.platform, "facebook"), eq(accounts.enabled, true)))
    .returning({ id: accounts.id });
  if (!page) throw fail(404, "không có Page Facebook đang bật này");
  await db.batch([
    db.delete(pageTimes).where(eq(pageTimes.accountId, id)),
    ...body.slots.map((s) => db.insert(pageTimes).values({ accountId: id, ...s })),
  ]);
  // Vừa chọn thư mục: đọc video của nó ngay để lên lịch được luôn (lỗi Drive thì cron đồng bộ lại sau).
  if (body.reelFolder) await syncReelVideos(db, c.env, Date.now()).catch((err: Error) => log("warn", "reel_sync_skipped", { message: err.message }));
  await clearFutureAuto(db, { accountId: id });
  return c.json(summary(await planAutoPosts(db, Date.now(), await appTimeZone(db))));
});

/** Lập lịch ngay (bình thường cron tự chạy mỗi giờ). */
autoRoutes.post("/plan", async (c) => {
  const db = getDb(c.env);
  return c.json(summary(await planAutoPosts(db, Date.now(), await appTimeZone(db))));
});

/** Thư mục trên Google Drive, để chọn thư mục video Reels cho từng Page. */
autoRoutes.get("/folders", async (c) => {
  const db = getDb(c.env);
  try {
    return c.json(await listFolders(await driveAccessToken(db, c.env, Date.now())));
  } catch (err) {
    if (err instanceof PublishFailure) throw fail(400, `Google Drive: ${err.message}`);
    throw err;
  }
});
