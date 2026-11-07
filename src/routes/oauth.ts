import { and, eq, gt, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getDb } from "../db/client";
import { oauthStates } from "../db/schema";
import type { AppEnv } from "../env";
import { savePinterestAccount, saveFacebookPages } from "../lib/accounts";
import { fail } from "../lib/http";
import { log } from "../lib/log";
import * as facebook from "../platforms/facebook";
import { PlatformError } from "../platforms/errors";
import * as pinterest from "../platforms/pinterest";

const STATE_TTL_MS = 10 * 60_000;
type Platform = "facebook" | "pinterest";

function platformParam(c: Context<AppEnv>): Platform {
  const p = c.req.param("platform");
  if (p !== "facebook" && p !== "pinterest") throw fail(404, "nền tảng không hỗ trợ");
  return p;
}

// Phải trùng khớp tuyệt đối với Redirect URI đã khai báo trên Meta/Pinterest.
const redirectUri = (c: Context<AppEnv>, platform: Platform) =>
  `${new URL(c.req.url).origin}/api/oauth/${platform}/callback`;

const backToAccounts = (c: Context<AppEnv>, error?: string) =>
  c.redirect(`/#/accounts${error ? `?error=${encodeURIComponent(error)}` : ""}`);

export const oauthRoutes = new Hono<AppEnv>();

oauthRoutes.get("/:platform/start", async (c) => {
  const platform = platformParam(c);
  const db = getDb(c.env);
  const now = Date.now();
  const state = crypto.randomUUID();
  await db.batch([
    db.delete(oauthStates).where(lt(oauthStates.createdAt, now - STATE_TTL_MS)),
    db.insert(oauthStates).values({ state, platform, createdAt: now }),
  ]);
  const url =
    platform === "facebook"
      ? facebook.authorizeUrl(facebook.facebookConfig(c.env), redirectUri(c, platform), state)
      : pinterest.authorizeUrl(pinterest.pinterestConfig(c.env), redirectUri(c, platform), state);
  return c.redirect(url);
});

oauthRoutes.get("/:platform/callback", async (c) => {
  const platform = platformParam(c);
  const db = getDb(c.env);
  const now = Date.now();
  const { state = "", code, error } = c.req.query();
  // Xoá và kiểm cùng lúc: mỗi state chỉ dùng được một lần, đúng nền tảng, còn hạn (chống CSRF).
  const consumed = await db
    .delete(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.platform, platform), gt(oauthStates.createdAt, now - STATE_TTL_MS)))
    .returning();
  if (consumed.length === 0) throw fail(400, "state OAuth không hợp lệ hoặc đã hết hạn");
  if (error || !code) return backToAccounts(c, error ?? "thiếu code");

  try {
    if (platform === "facebook") {
      const cfg = facebook.facebookConfig(c.env);
      const userToken = await facebook.exchangeCode(cfg, redirectUri(c, platform), code);
      await saveFacebookPages(db, c.env, await facebook.listPages(cfg, userToken), now);
    } else {
      const cfg = pinterest.pinterestConfig(c.env);
      const tokens = await pinterest.exchangeCode(cfg, redirectUri(c, platform), code, now);
      const username = await pinterest.getUsername(cfg, tokens.accessToken);
      await savePinterestAccount(db, c.env, username, tokens, await pinterest.listBoards(cfg, tokens.accessToken), now);
    }
  } catch (err) {
    if (!(err instanceof PlatformError)) throw err;
    log("warn", "oauth_failed", { platform, op: err.op, status: err.status });
    return backToAccounts(c, `${platform}: ${err.message}`);
  }
  return backToAccounts(c);
});
