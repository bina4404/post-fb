import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { accounts, boards } from "../db/schema";
import type { AppEnv } from "../env";
import { fail, idParam, readJson } from "../lib/http";

const enabledBody = z.object({ enabled: z.boolean() });

export const accountRoutes = new Hono<AppEnv>();

// Không bao giờ trả token: chỉ chọn các cột an toàn.
accountRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const [accountList, boardList] = await Promise.all([
    db
      .select({
        id: accounts.id,
        platform: accounts.platform,
        name: accounts.name,
        enabled: accounts.enabled,
        status: accounts.status,
        accessExpiresAt: accounts.accessExpiresAt,
      })
      .from(accounts),
    db.select().from(boards),
  ]);
  return c.json({ accounts: accountList, boards: boardList });
});

accountRoutes.patch("/:id", async (c) => {
  const { enabled } = await readJson(c, enabledBody);
  const [row] = await getDb(c.env).update(accounts).set({ enabled, updatedAt: Date.now() }).where(eq(accounts.id, idParam(c))).returning({ id: accounts.id });
  if (!row) throw fail(404, "không tìm thấy tài khoản");
  return c.json({ id: row.id, enabled });
});

// Không xoá dòng (post_targets và lịch sử trỏ tới), chỉ xoá token.
accountRoutes.post("/:id/disconnect", async (c) => {
  const [row] = await getDb(c.env)
    .update(accounts)
    .set({ accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null, enabled: false, status: "needs_reauth", updatedAt: Date.now() })
    .where(eq(accounts.id, idParam(c)))
    .returning({ id: accounts.id });
  if (!row) throw fail(404, "không tìm thấy tài khoản");
  return c.body(null, 204);
});

export const boardRoutes = new Hono<AppEnv>();

boardRoutes.patch("/:id", async (c) => {
  const { enabled } = await readJson(c, enabledBody);
  const [row] = await getDb(c.env).update(boards).set({ enabled }).where(eq(boards.id, idParam(c))).returning({ id: boards.id });
  if (!row) throw fail(404, "không tìm thấy board");
  return c.json({ id: row.id, enabled });
});
