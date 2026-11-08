import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, type Db } from "../db/client";
import { postTargets, scheduleSlots } from "../db/schema";
import type { AppEnv } from "../env";
import { fail, idParam, readJson } from "../lib/http";
import { setSchedule } from "../lib/schedule";
import { upcomingSlotTimes } from "../lib/slots";
import { parseScheduleTime, TIME_ZONE_IDS, type TimeZone } from "../lib/time";
import { enqueueTargets } from "../jobs/cron";
import { loadPost } from "./posts";

const scheduleBody = z.union([
  z.object({ scheduledAt: z.string() }),
  // tz: khung giờ (vd. T2 09:00) được hiểu theo múi giờ này.
  z.object({ queue: z.literal(true), tz: z.enum(TIME_ZONE_IDS).optional() }),
]);

/** Giành slot trống đầu tiên bằng một câu UPDATE nguyên tử, để hai yêu cầu song song không lấy chung slot. */
export async function claimNextSlot(db: Db, postId: number, now: number, tz?: TimeZone): Promise<number> {
  const slots = await db.select().from(scheduleSlots);
  for (const t of upcomingSlotTimes(slots, now, 28, tz)) {
    const result = await db.run(
      sql`UPDATE posts SET scheduled_at = ${t}, updated_at = ${now}
          WHERE id = ${postId} AND NOT EXISTS (SELECT 1 FROM posts WHERE scheduled_at = ${t})`,
    );
    if (result.meta.changes > 0) return t;
  }
  throw fail(409, "không còn khung giờ trống trong 4 tuần tới");
}

export const scheduleRoutes = new Hono<AppEnv>();

scheduleRoutes.post("/:id/schedule", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  const now = Date.now();
  const body = await readJson(c, scheduleBody);
  await loadPost(db, id);
  let at: number;
  if ("queue" in body) {
    at = await claimNextSlot(db, id, now, body.tz);
  } else {
    const parsed = parseScheduleTime(body.scheduledAt);
    if (parsed === null || parsed <= now) throw fail(400, "scheduledAt phải là thời điểm hợp lệ trong tương lai");
    at = parsed;
  }
  await setSchedule(db, id, at, now);
  return c.json(await loadPost(db, id));
});

/**
 * "Đăng ngay": đặt lịch là bây giờ rồi đẩy thẳng các target vào queue (có giãn cách giữa các Page), không chờ cron.
 * Cron có đẩy trùng thì consumer vẫn chỉ đăng một lần (giành target nguyên tử).
 */
scheduleRoutes.post("/:id/publish-now", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  const now = Date.now();
  await loadPost(db, id);
  await setSchedule(db, id, now, now);
  const due = await db
    .select({ id: postTargets.id, postId: postTargets.postId })
    .from(postTargets)
    .where(and(eq(postTargets.postId, id), eq(postTargets.status, "scheduled")));
  // Các Page được giãn cách 30–90 giây, không đăng đồng loạt cùng một nội dung.
  await enqueueTargets(db, c.env, due, now);
  return c.json(await loadPost(db, id));
});

scheduleRoutes.post("/:id/unschedule", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  await loadPost(db, id);
  await setSchedule(db, id, null, Date.now());
  return c.json(await loadPost(db, id));
});
