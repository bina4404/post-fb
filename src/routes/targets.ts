import { and, desc, eq, gte, isNull, lt, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { accounts, posts, postTargets, targetStatuses } from "../db/schema";
import type { AppEnv } from "../env";
import { fail, idParam } from "../lib/http";

const listQuery = z.object({
  status: z.enum(targetStatuses).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

export const targetRoutes = new Hono<AppEnv>();

/** Mỗi dòng là một target (bài × Page) kèm nội dung bài và tên đích. Lọc trên post_targets. */
targetRoutes.get("/", async (c) => {
  const q = listQuery.safeParse(c.req.query());
  if (!q.success) throw fail(400, z.prettifyError(q.error));
  const { status, from, to } = q.data;
  const filters: SQL[] = [];
  if (status) filters.push(eq(postTargets.status, status));
  if (from !== undefined) filters.push(gte(posts.scheduledAt, from));
  if (to !== undefined) filters.push(lt(posts.scheduledAt, to));

  // shortcut: tối đa 500 dòng, không phân trang; calendar tuần luôn nằm dưới mức này.
  const rows = await getDb(c.env)
    .select({
      id: postTargets.id,
      postId: postTargets.postId,
      platform: postTargets.platform,
      status: postTargets.status,
      attempts: postTargets.attempts,
      externalPostId: postTargets.externalPostId,
      lastError: postTargets.lastError,
      needsAttention: postTargets.needsAttention,
      updatedAt: postTargets.updatedAt,
      scheduledAt: posts.scheduledAt,
      caption: posts.caption,
      destination: accounts.name,
      accountStatus: accounts.status,
    })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .innerJoin(accounts, eq(accounts.id, postTargets.accountId))
    .where(and(...filters))
    .orderBy(desc(posts.scheduledAt), desc(postTargets.id))
    .limit(500);
  return c.json(rows);
});

/**
 * "Đăng lại" target failed. Chỉ khi chưa có id bài trên nền tảng, để không bao giờ đăng trùng một bài đã lên.
 * Target được đặt đến hạn ngay, phút cron kế tiếp sẽ đẩy nó đi.
 */
targetRoutes.post("/:id/retry", async (c) => {
  const now = Date.now();
  const [row] = await getDb(c.env)
    .update(postTargets)
    .set({ status: "scheduled", attempts: 0, nextAttemptAt: now, lockedAt: null, lastError: null, needsAttention: false, updatedAt: now })
    .where(and(eq(postTargets.id, idParam(c)), eq(postTargets.status, "failed"), isNull(postTargets.externalPostId)))
    .returning({ id: postTargets.id, status: postTargets.status });
  if (!row) throw fail(409, "chỉ đăng lại được bài failed chưa có trên nền tảng");
  return c.json(row);
});
