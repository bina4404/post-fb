import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { appSettings } from "../db/schema";
import type { AppEnv } from "../env";
import { clearFutureAuto, planAutoPosts } from "../jobs/planner";
import { readJson } from "../lib/http";
import { appTimeZone, SETTINGS_ID } from "../lib/settings";
import { TIME_ZONE_IDS } from "../lib/time";

const settingsBody = z.object({ timeZone: z.enum(TIME_ZONE_IDS) });

export const settingRoutes = new Hono<AppEnv>();

/** Cài đặt chung của app. Chưa lưu lần nào thì dùng múi giờ mặc định. */
settingRoutes.get("/", async (c) => {
  return c.json({ timeZone: await appTimeZone(getDb(c.env)) });
});

settingRoutes.put("/", async (c) => {
  const { timeZone } = await readJson(c, settingsBody);
  const db = getDb(c.env);
  const before = await appTimeZone(db);
  const values = { timeZone, updatedAt: Date.now() };
  await db.insert(appSettings).values({ id: SETTINGS_ID, ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
  // Giờ đăng tự động là giờ địa phương: đổi múi giờ thì lập lại các bài tự động chưa đi theo giờ mới.
  if (before !== timeZone) {
    await clearFutureAuto(db, {});
    await planAutoPosts(db, Date.now(), timeZone);
  }
  return c.json({ timeZone });
});
