import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { topics } from "../db/schema";
import type { AppEnv } from "../env";
import { clearFutureAuto, planAutoPosts } from "../jobs/planner";
import { fail, idParam, readJson } from "../lib/http";
import { appTimeZone } from "../lib/settings";

const name = z.string().trim().min(1).max(100);
const brief = z.string().trim().max(1000);
const createBody = z.object({ name, brief: brief.default("") });
const patchBody = z.object({ name: name.optional(), brief: brief.optional(), enabled: z.boolean().optional() });

/** Chủ đề nội dung. Không xoá (bài cũ trỏ tới để đo hiệu quả), chỉ tắt: chủ đề tắt không được lên lịch nữa. */
export const topicRoutes = new Hono<AppEnv>();

topicRoutes.get("/", async (c) => c.json(await getDb(c.env).select().from(topics).orderBy(asc(topics.id))));

topicRoutes.post("/", async (c) => {
  const body = await readJson(c, createBody);
  const [topic] = await getDb(c.env).insert(topics).values({ ...body, createdAt: Date.now() }).returning();
  return c.json(topic, 201);
});

topicRoutes.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const body = await readJson(c, patchBody);
  const [topic] = await db.update(topics).set(body).where(eq(topics.id, idParam(c))).returning();
  if (!topic) throw fail(404, "không có chủ đề này");
  if (body.enabled !== undefined) {
    // Tắt: gỡ bài tự động chưa đi của chủ đề này rồi lấp lại bằng chủ đề khác. Bật lại: lấp các khung giờ trống.
    if (!topic.enabled) await clearFutureAuto(db, { topicId: topic.id });
    await planAutoPosts(db, Date.now(), await appTimeZone(db));
  }
  return c.json(topic);
});
