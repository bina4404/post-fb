import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSettings } from "../db/schema";
import { DEFAULT_TZ, isTimeZone, type TimeZone } from "./time";

export const SETTINGS_ID = 1;

/** Múi giờ chung của app (bảng app_settings); chưa lưu thì là múi giờ mặc định. */
export async function appTimeZone(db: Db): Promise<TimeZone> {
  const [row] = await db.select({ timeZone: appSettings.timeZone }).from(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  return row && isTimeZone(row.timeZone) ? row.timeZone : DEFAULT_TZ;
}
