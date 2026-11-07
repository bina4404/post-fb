import { Hono } from "hono";
import { getDb } from "../db/client";
import type { AppEnv } from "../env";
import { parseCsv } from "../lib/csv";
import { fail } from "../lib/http";
import { insertPost, loadDestinations } from "../lib/posts";

const MAX_CSV_BYTES = 1024 * 1024;

export const importRoutes = new Hono<AppEnv>();

importRoutes.post("/", async (c) => {
  const text = await c.req.text();
  if (text.length > MAX_CSV_BYTES) throw fail(400, "file CSV quá 1MB");
  const db = getDb(c.env);
  const now = Date.now();
  const result = parseCsv(text, await loadDestinations(db), now);
  if ("errors" in result) return c.json({ errors: result.errors }, 422);

  // D1 batch là một transaction: hoặc ghi hết, hoặc không ghi dòng nào.
  const [first, ...rest] = result.posts.flatMap((p) => insertPost(db, p, now));
  await db.batch([first!, ...rest]); // parseCsv đảm bảo có ít nhất 1 bài
  return c.json({ imported: result.posts.length });
});
