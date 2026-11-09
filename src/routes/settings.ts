import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { appSettings } from "../db/schema";
import type { AppEnv } from "../env";
import { readJson } from "../lib/http";
import { DEFAULT_TZ, TIME_ZONE_IDS } from "../lib/time";

const SETTINGS_ID = 1;
const settingsBody = z.object({ timeZone: z.enum(TIME_ZONE_IDS) });

export const settingRoutes = new Hono<AppEnv>();

/** Cài đặt chung của app. Chưa lưu lần nào thì dùng múi giờ mặc định. */
settingRoutes.get("/", async (c) => {
  const [row] = await getDb(c.env).select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  return c.json({ timeZone: row?.timeZone ?? DEFAULT_TZ });
});

settingRoutes.put("/", async (c) => {
  const { timeZone } = await readJson(c, settingsBody);
  const values = { timeZone, updatedAt: Date.now() };
  await getDb(c.env)
    .insert(appSettings)
    .values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: appSettings.id, set: values });
  return c.json({ timeZone });
});
