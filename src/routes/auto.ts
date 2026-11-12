import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { accounts, pageTimes } from "../db/schema";
import type { AppEnv } from "../env";
import { clearFutureAuto, planAutoPosts, upcomingAutoCounts, type PlanResult } from "../jobs/planner";
import { minImagesNeeded } from "../lib/autoplan";
import { fail, idParam, readJson } from "../lib/http";
import { PAGE_DAILY_CAP, PAGE_MIN_GAP_MS } from "../lib/pacing";
import { appTimeZone } from "../lib/settings";
import { readyImageCount } from "./images";

const MIN_GAP_MINUTES = PAGE_MIN_GAP_MS / 60_000;

/** Giờ đăng của một Page: không trùng, tối đa PAGE_DAILY_CAP giờ/ngày, cách nhau ≥ PAGE_MIN_GAP (tính cả qua nửa đêm). */
const pageBody = z.object({
  autoEnabled: z.boolean(),
  times: z
    .array(z.int().min(0).max(1439))
    .max(PAGE_DAILY_CAP)
    .refine((t) => new Set(t).size === t.length, "giờ đăng bị trùng")
    .refine((t) => {
      const sorted = [...t].sort((a, b) => a - b);
      return sorted.every((m, i) => (i === 0 ? sorted.length < 2 || m + 1440 - sorted.at(-1)! >= MIN_GAP_MINUTES : m - sorted[i - 1]! >= MIN_GAP_MINUTES));
    }, `các giờ đăng phải cách nhau ít nhất ${MIN_GAP_MINUTES} phút`),
});

const summary = (plan: PlanResult) => ({ created: plan.created, shortages: plan.shortages.length });

export const autoRoutes = new Hono<AppEnv>();

/** Tổng quan đăng tự động: giờ đăng từng Page, số bài sắp tới, số ảnh sẵn sàng và số ảnh tối thiểu cần có. */
autoRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const [pages, times, counts, ready] = await Promise.all([
    db
      .select({ id: accounts.id, name: accounts.name, autoEnabled: accounts.autoEnabled, status: accounts.status })
      .from(accounts)
      .where(and(eq(accounts.platform, "facebook"), eq(accounts.enabled, true))),
    db.select().from(pageTimes),
    upcomingAutoCounts(db, now),
    readyImageCount(db),
  ]);
  const list = pages.map((p) => ({
    ...p,
    times: times.filter((t) => t.accountId === p.id).map((t) => t.minuteOfDay).sort((a, b) => a - b),
    upcoming: Number(counts.find((n) => n.accountId === p.id)?.n ?? 0),
  }));
  const active = list.filter((p) => p.autoEnabled).map((p) => p.times.length);
  return c.json({ pages: list, readyImages: ready, minImagesNeeded: minImagesNeeded(active) });
});

/** Lưu giờ đăng và bật/tắt tự động của một Page; lập lại 7 ngày tới cho Page đó theo cài đặt mới. */
autoRoutes.put("/pages/:id", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  const body = await readJson(c, pageBody);
  const [page] = await db
    .update(accounts)
    .set({ autoEnabled: body.autoEnabled, updatedAt: Date.now() })
    .where(and(eq(accounts.id, id), eq(accounts.platform, "facebook"), eq(accounts.enabled, true)))
    .returning({ id: accounts.id });
  if (!page) throw fail(404, "không có Page Facebook đang bật này");
  await db.batch([
    db.delete(pageTimes).where(eq(pageTimes.accountId, id)),
    ...body.times.map((minuteOfDay) => db.insert(pageTimes).values({ accountId: id, minuteOfDay })),
  ]);
  await clearFutureAuto(db, { accountId: id });
  return c.json(summary(await planAutoPosts(db, Date.now(), await appTimeZone(db))));
});

/** Lập lịch ngay (bình thường cron tự chạy mỗi giờ). */
autoRoutes.post("/plan", async (c) => {
  const db = getDb(c.env);
  return c.json(summary(await planAutoPosts(db, Date.now(), await appTimeZone(db))));
});
