// Bộ lập lịch đăng tự động: lấp kín 7 ngày tới cho mọi Page bật "tự động" bằng ảnh trong kho.
// Bài tạo ra là bài bình thường (posts + post_targets), nên giãn cách, retry, "Đăng lại"... đều áp dụng như bài tay.
import { and, eq, gte, inArray, isNotNull, like, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, images, pageTimes, posts, postTargets } from "../db/schema";
import { autoKey, PLAN_DAYS, planPosts, SAME_PAGE_GAP_MS, upcomingPageSlots, type PlanSlot } from "../lib/autoplan";
import { log } from "../lib/log";
import { insertPost } from "../lib/posts";
import { DAY_MS } from "../lib/time";

/** Mỗi lượt tạo tối đa bấy nhiêu bài, để không vượt giới hạn số câu lệnh D1 của một request; phần còn lại lượt sau làm tiếp. */
const MAX_PER_RUN = 150;
const BATCH_POSTS = 40;

export type PlanResult = { created: number; shortages: PlanSlot[] };

async function autoPages(db: Db): Promise<number[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.platform, "facebook"), eq(accounts.enabled, true), eq(accounts.autoEnabled, true), eq(accounts.status, "ok"), isNotNull(accounts.accessTokenEnc)));
  return rows.map((r) => r.id);
}

/** Các lần ảnh đã/sẽ đăng quanh khoảng lập lịch (kể cả bài tay), trừ lần lỗi vì bài đó chưa lên. */
async function imageUses(db: Db, now: number) {
  const rows = await db
    .select({ imageKey: posts.imageKey, accountId: postTargets.accountId, at: posts.scheduledAt })
    .from(posts)
    .innerJoin(postTargets, eq(postTargets.postId, posts.id))
    .where(and(isNotNull(posts.imageKey), gte(posts.scheduledAt, now - SAME_PAGE_GAP_MS), lte(posts.scheduledAt, now + (PLAN_DAYS + 7) * DAY_MS), ne(postTargets.status, "failed")));
  return rows.map((r) => ({ imageKey: r.imageKey!, accountId: r.accountId, at: r.at! }));
}

export async function planAutoPosts(db: Db, now: number, tz: string): Promise<PlanResult> {
  const pageIds = await autoPages(db);
  if (pageIds.length === 0) return { created: 0, shortages: [] };
  const times = await db.select().from(pageTimes).where(inArray(pageTimes.accountId, pageIds));
  const existing = await db
    .select({ key: postTargets.idempotencyKey })
    .from(postTargets)
    .where(and(inArray(postTargets.accountId, pageIds), like(postTargets.idempotencyKey, "auto:%"), gte(postTargets.updatedAt, now - 2 * PLAN_DAYS * DAY_MS)));
  const taken = new Set(existing.map((e) => e.key));
  const free = upcomingPageSlots(times, now, tz).filter((s) => !taken.has(autoKey(s)));
  if (free.length === 0) return { created: 0, shortages: [] };

  const pool = await db.select({ driveFileId: images.driveFileId, captions: images.captions }).from(images).where(eq(images.enabled, true));
  const { planned, shortages } = planPosts(free.slice(0, MAX_PER_RUN), pool, await imageUses(db, now));
  let created = 0;
  for (let i = 0; i < planned.length; i += BATCH_POSTS) {
    const chunk = planned.slice(i, i + BATCH_POSTS);
    const [first, ...rest] = chunk.flatMap((p) =>
      insertPost(db, { caption: p.caption, link: null, imageKey: p.imageKey, imageUrl: null, scheduledAt: p.at, targets: [{ platform: "facebook", accountId: p.accountId, key: autoKey(p) }] }, now),
    );
    try {
      await db.batch([first!, ...rest]);
      created += chunk.length;
    } catch (err) {
      // Lượt khác vừa tạo trùng khung giờ (khoá auto:... là unique): cả batch huỷ, lượt sau tạo phần còn thiếu.
      log("warn", "autoplan_batch_skipped", { message: (err as Error).message });
    }
  }
  if (created || shortages.length) log("info", "autoplan_done", { created, shortages: shortages.length });
  return { created, shortages };
}

/**
 * Xoá bài tự động CHƯA đi (nháp/chờ) của một Page hoặc một ảnh, để lập lại theo cài đặt mới.
 * Không đụng bài đang đăng, đã đăng hay lỗi.
 */
export async function clearFutureAuto(db: Db, filter: { accountId?: number; imageKey?: string }) {
  const targetFilter = and(
    like(postTargets.idempotencyKey, "auto:%"),
    inArray(postTargets.status, ["draft", "scheduled"]),
    filter.accountId ? eq(postTargets.accountId, filter.accountId) : undefined,
  );
  await db
    .delete(posts)
    .where(and(inArray(posts.id, db.select({ id: postTargets.postId }).from(postTargets).where(targetFilter)), filter.imageKey ? eq(posts.imageKey, filter.imageKey) : undefined));
}

/** Đổi caption của ảnh: bài tự động chưa đi dùng ảnh đó lấy lại ngẫu nhiên một caption mới. */
export async function refreshAutoCaptions(db: Db, imageKey: string, captions: string[], now: number) {
  if (captions.length === 0) return clearFutureAuto(db, { imageKey });
  const pending = await db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(postTargets, eq(postTargets.postId, posts.id))
    .where(and(eq(posts.imageKey, imageKey), like(postTargets.idempotencyKey, "auto:%"), inArray(postTargets.status, ["draft", "scheduled"])));
  const [first, ...rest] = pending.map((p) =>
    db.update(posts).set({ caption: captions[Math.floor(Math.random() * captions.length)]!, updatedAt: now }).where(eq(posts.id, p.id)),
  );
  if (first) await db.batch([first, ...rest]);
}

/** Số bài tự động sắp tới của từng Page. */
export async function upcomingAutoCounts(db: Db, now: number) {
  return db
    .select({ accountId: postTargets.accountId, n: sql<number>`count(*)` })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(and(like(postTargets.idempotencyKey, "auto:%"), inArray(postTargets.status, ["draft", "scheduled"]), gte(posts.scheduledAt, now)))
    .groupBy(postTargets.accountId);
}
