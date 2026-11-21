// Thống kê Page Facebook: lấy trực tiếp từ Graph API mỗi lần xem (Facebook giữ lịch sử 2 năm), không lưu vào D1.
import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { accounts } from "../db/schema";
import type { AppEnv, WorkerEnv } from "../env";
import { withDistinctNames } from "../lib/accounts";
import { decryptToken } from "../lib/crypto";
import { fail, idParam } from "../lib/http";
import { PlatformError, PublishFailure } from "../platforms/errors";
import * as facebook from "../platforms/facebook";

const DAY_MS = 86_400_000;
const rangeQuery = z.object({ days: z.enum(["7", "28", "90"]).default("28") });

type PageRow = { id: number; name: string; externalId: string; accessTokenEnc: string | null };

/** Khoảng thời gian [since, until] tính đến hiện tại; Facebook cho xem tối đa 90 ngày một lần. */
function range(c: { req: { query: () => Record<string, string> } }) {
  const q = rangeQuery.safeParse(c.req.query());
  if (!q.success) throw fail(400, "days phải là 7, 28 hoặc 90");
  const until = Date.now();
  return { since: until - Number(q.data.days) * DAY_MS, until };
}

/**
 * Lỗi Facebook thành câu dễ hiểu, luôn kèm lỗi gốc. Thiếu quyền (mã 10/200): hỏi debug_token xem token của Page
 * đã có read_insights chưa, để phân biệt "cần kết nối lại" với "Page/tài khoản không đủ điều kiện".
 */
async function explain(env: WorkerEnv, token: string, err: unknown): Promise<string> {
  if (!(err instanceof PublishFailure)) throw err;
  if (!(err instanceof PlatformError && (err.code === 10 || err.code === 200))) return err.message;
  const scopes = await facebook.tokenScopes(facebook.facebookConfig(env), token).catch(() => null);
  if (scopes && !scopes.includes("read_insights")) {
    return `token của Page chưa có quyền read_insights: ở tab Tài khoản bấm Kết nối Facebook, chọn lại đủ các Page và bật quyền xem thống kê (Facebook: ${err.message})`;
  }
  const known = scopes ? "Token đã có quyền read_insights, nên thường do " : "Thường do ";
  return `Facebook từ chối xem thống kê: ${err.message}. ${known}Page dưới 100 lượt thích, hoặc tài khoản của bạn không có quyền phân tích (xem thông tin chi tiết) trên Page này`;
}

const totals = (daily: facebook.DailySeries) =>
  Object.fromEntries(facebook.PAGE_METRICS.map((m) => [m, (daily[m] ?? []).reduce((sum, d) => sum + d.value, 0)])) as Record<facebook.PageMetric, number>;

async function pageStats(env: WorkerEnv, page: PageRow, token: string, since: number, until: number) {
  const cfg = facebook.facebookConfig(env);
  const [followers, daily] = await Promise.all([facebook.pageFollowers(cfg, page.externalId, token), facebook.pageInsights(cfg, page.externalId, token, since, until)]);
  return { followers, daily, totals: totals(daily) };
}

const connectedPages = (env: WorkerEnv) =>
  getDb(env)
    .select({ id: accounts.id, name: accounts.name, externalId: accounts.externalId, accessTokenEnc: accounts.accessTokenEnc })
    .from(accounts)
    .where(and(eq(accounts.platform, "facebook"), eq(accounts.enabled, true), isNotNull(accounts.accessTokenEnc)));

export const insightRoutes = new Hono<AppEnv>();

/** Tổng quan mọi Page đang bật: người theo dõi và tổng các chỉ số trong khoảng. Page lỗi trả `error`, không làm hỏng cả bảng. */
insightRoutes.get("/", async (c) => {
  const { since, until } = range(c);
  const pages = withDistinctNames(await connectedPages(c.env));
  const rows = await Promise.all(
    pages.map(async (p) => {
      const token = await decryptToken(p.accessTokenEnc!, c.env.TOKEN_ENC_KEY);
      try {
        const { followers, totals: sums } = await pageStats(c.env, p, token, since, until);
        return { id: p.id, name: p.name, followers, totals: sums, error: null };
      } catch (err) {
        return { id: p.id, name: p.name, followers: null, totals: null, error: await explain(c.env, token, err) };
      }
    }),
  );
  return c.json({ since, until, pages: rows });
});

/** Chi tiết một Page: số liệu theo ngày và các bài đã đăng trong khoảng (để xếp hạng nội dung hàng đầu). */
insightRoutes.get("/:id", async (c) => {
  const { since, until } = range(c);
  const page = (await connectedPages(c.env)).find((p) => p.id === idParam(c));
  if (!page) throw fail(404, "không có Page Facebook đang bật này");
  const token = await decryptToken(page.accessTokenEnc!, c.env.TOKEN_ENC_KEY);
  try {
    const stats = await pageStats(c.env, page, token, since, until);
    const posts = await facebook.topPosts(facebook.facebookConfig(c.env), page.externalId, token, since, until);
    return c.json({ since, until, followers: stats.followers, daily: stats.daily, totals: stats.totals, posts });
  } catch (err) {
    throw fail(400, await explain(c.env, token, err));
  }
});
