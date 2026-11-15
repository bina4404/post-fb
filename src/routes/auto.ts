import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { accounts, images, pageTimes } from "../db/schema";
import type { AppEnv } from "../env";
import { syncReelVideos } from "../jobs/drive-sync";
import { clearFutureAuto, planAutoPosts, upcomingAutoCounts, type PlanResult } from "../jobs/planner";
import { minImagesNeeded } from "../lib/autoplan";
import { driveAccessToken, withDistinctNames } from "../lib/accounts";
import { fail, idParam, readJson } from "../lib/http";
import { log } from "../lib/log";
import { PAGE_DAILY_CAP, PAGE_MIN_GAP_MS } from "../lib/pacing";
import { appTimeZone } from "../lib/settings";
import { driveFileId, listFolders } from "../platforms/drive";
import { PublishFailure } from "../platforms/errors";
import { readyImageCount } from "./images";

const MIN_GAP_MINUTES = PAGE_MIN_GAP_MS / 60_000;

const minutes = z.array(z.int().min(0).max(1439)).max(PAGE_DAILY_CAP);

/**
 * Giờ đăng ảnh + giờ đăng Reels của một Page, xét chung: không trùng, tổng tối đa PAGE_DAILY_CAP giờ/ngày,
 * cách nhau ≥ PAGE_MIN_GAP (tính cả qua nửa đêm). reelFolder: thư mục video trên Drive (null = bỏ chọn, thiếu = giữ nguyên).
 */
const pageBody = z
  .object({
    autoEnabled: z.boolean(),
    times: minutes,
    reelTimes: minutes.default([]),
    reelFolder: z.object({ id: driveFileId, name: z.string().trim().min(1).max(300) }).nullish(),
  })
  .refine((b) => b.times.length + b.reelTimes.length <= PAGE_DAILY_CAP, `tối đa ${PAGE_DAILY_CAP} giờ đăng mỗi ngày (ảnh + Reels)`)
  .refine((b) => new Set([...b.times, ...b.reelTimes]).size === b.times.length + b.reelTimes.length, "giờ đăng bị trùng")
  .refine((b) => {
    const sorted = [...b.times, ...b.reelTimes].sort((x, y) => x - y);
    return sorted.every((m, i) => (i === 0 ? sorted.length < 2 || m + 1440 - sorted.at(-1)! >= MIN_GAP_MINUTES : m - sorted[i - 1]! >= MIN_GAP_MINUTES));
  }, `các giờ đăng (ảnh và Reels) phải cách nhau ít nhất ${MIN_GAP_MINUTES} phút`);

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

/** Tổng quan đăng tự động: giờ đăng từng Page, số bài sắp tới, số ảnh sẵn sàng và số ảnh tối thiểu cần có. */
autoRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const [pages, times, counts, ready, videos] = await Promise.all([
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
  ]);
  const of = (id: number, kind: "image" | "reel") => times.filter((t) => t.accountId === id && t.kind === kind).map((t) => t.minuteOfDay).sort((a, b) => a - b);
  const upcoming = (id: number, kind: "image" | "reel") => Number(counts.find((n) => n.accountId === id && n.kind === kind)?.n ?? 0);
  const list = withDistinctNames(pages).map((p) => ({
    ...p,
    times: of(p.id, "image"),
    reelTimes: of(p.id, "reel"),
    upcoming: upcoming(p.id, "image"),
    upcomingReels: upcoming(p.id, "reel"),
    readyVideos: p.reelFolderId ? (videos.get(p.reelFolderId) ?? 0) : 0,
  }));
  const active = list.filter((p) => p.autoEnabled).map((p) => p.times.length);
  return c.json({ pages: list, readyImages: ready, minImagesNeeded: minImagesNeeded(active) });
});

/** Lưu giờ đăng và bật/tắt tự động của một Page; lập lại 7 ngày tới cho Page đó theo cài đặt mới. */
autoRoutes.put("/pages/:id", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  const body = await readJson(c, pageBody);
  const folder = body.reelFolder === undefined ? {} : { reelFolderId: body.reelFolder?.id ?? null, reelFolderName: body.reelFolder?.name ?? null };
  const [page] = await db
    .update(accounts)
    .set({ autoEnabled: body.autoEnabled, ...folder, updatedAt: Date.now() })
    .where(and(eq(accounts.id, id), eq(accounts.platform, "facebook"), eq(accounts.enabled, true)))
    .returning({ id: accounts.id });
  if (!page) throw fail(404, "không có Page Facebook đang bật này");
  await db.batch([
    db.delete(pageTimes).where(eq(pageTimes.accountId, id)),
    ...body.times.map((minuteOfDay) => db.insert(pageTimes).values({ accountId: id, minuteOfDay, kind: "image" })),
    ...body.reelTimes.map((minuteOfDay) => db.insert(pageTimes).values({ accountId: id, minuteOfDay, kind: "reel" })),
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
