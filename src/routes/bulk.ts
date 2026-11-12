import { and, inArray, notExists, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getDb } from "../db/client";
import { posts, postTargets } from "../db/schema";
import type { AppEnv } from "../env";
import { readJson } from "../lib/http";
import { hasPendingTarget } from "../lib/library";
import { setSchedule } from "../lib/schedule";
import { TIME_ZONE_IDS } from "../lib/time";
import { claimNextSlot } from "./schedule";

const bulkBody = z.object({
  ids: z.array(z.int().positive()).min(1).max(200),
  action: z.enum(["queue", "delete"]),
  tz: z.enum(TIME_ZONE_IDS).optional(),
});
type Skipped = { id: number; reason: string };

export const bulkRoutes = new Hono<AppEnv>();

/**
 * Thao tác hàng loạt trên nhiều bài. Bài nào không làm được thì bỏ qua và trả lý do, không làm hỏng cả lượt.
 * queue: lần lượt xếp từng bài vào khung giờ trống sớm nhất. delete: xoá các bài chưa có Page nào đã/đang đăng.
 */
bulkRoutes.post("/bulk", async (c) => {
  const db = getDb(c.env);
  const { ids, action, tz } = await readJson(c, bulkBody);
  const unique = [...new Set(ids)];
  const done: number[] = [];
  const skipped: Skipped[] = [];
  const now = Date.now();

  if (action === "delete") {
    const locked = sql`${postTargets.postId} = ${posts.id} AND ${postTargets.status} IN ('published', 'publishing')`;
    // Xoá từng nhóm 90 id: D1 cho phép tối đa 100 tham số mỗi câu SQL.
    for (let i = 0; i < unique.length; i += 90) {
      const deleted = await db
        .delete(posts)
        .where(and(inArray(posts.id, unique.slice(i, i + 90)), notExists(db.select({ x: sql`1` }).from(postTargets).where(locked))))
        .returning({ id: posts.id });
      done.push(...deleted.map((d) => d.id));
    }
    for (const id of unique) if (!done.includes(id)) skipped.push({ id, reason: "đã/đang đăng hoặc không tồn tại" });
    return c.json({ done, skipped });
  }

  for (const [i, id] of unique.entries()) {
    if (!(await hasPendingTarget(db, id))) {
      skipped.push({ id, reason: "không còn Page nào chờ đăng" });
      continue;
    }
    try {
      await setSchedule(db, id, await claimNextSlot(db, id, now, tz), now);
      done.push(id);
    } catch (err) {
      if (!(err instanceof HTTPException) || err.status !== 409) throw err;
      // Hết khung giờ trống: các bài còn lại cũng không xếp được.
      for (const rest of unique.slice(i)) skipped.push({ id: rest, reason: "hết khung giờ trống trong 4 tuần tới" });
      break;
    }
  }
  return c.json({ done, skipped });
});
