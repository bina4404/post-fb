import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { scheduleSlots } from "../db/schema";
import type { AppEnv } from "../env";
import { fail, idParam, readJson } from "../lib/http";

const slotBody = z.object({
  weekday: z.int().min(0).max(6),
  minuteOfDay: z.int().min(0).max(1439),
});

export const slotRoutes = new Hono<AppEnv>();

slotRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  return c.json(await db.select().from(scheduleSlots).orderBy(asc(scheduleSlots.weekday), asc(scheduleSlots.minuteOfDay)));
});

slotRoutes.post("/", async (c) => {
  const db = getDb(c.env);
  const body = await readJson(c, slotBody);
  const [slot] = await db.insert(scheduleSlots).values(body).onConflictDoNothing().returning();
  if (!slot) throw fail(409, "khung giờ đã có");
  return c.json(slot, 201);
});

slotRoutes.delete("/:id", async (c) => {
  await getDb(c.env).delete(scheduleSlots).where(eq(scheduleSlots.id, idParam(c)));
  return c.body(null, 204);
});
