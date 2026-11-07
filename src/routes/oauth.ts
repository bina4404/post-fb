import { and, eq, gt, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getDb } from "../db/client";
import { oauthStates } from "../db/schema";
import type { AppEnv } from "../env";
import { saveFacebookPages, saveGoogleAccount, savePinterestAccount } from "../lib/accounts";
import { fail } from "../lib/http";
import { log } from "../lib/log";
import type { Db } from "../db/client";
import * as drive from "../platforms/drive";
import { PlatformError, PublishFailure } from "../platforms/errors";
import * as facebook from "../platforms/facebook";
import * as pinterest from "../platforms/pinterest";

const STATE_TTL_MS = 10 * 60_000;
type Env = AppEnv["Bindings"];
type Connector = {
  authorizeUrl: (env: Env, redirectUri: string, state: string) => string;
  connect: (env: Env, db: Db, redirectUri: string, code: string, now: number) => Promise<void>;
};

const connectors = {
  facebook: {
    authorizeUrl: (env, uri, state) => facebook.authorizeUrl(facebook.facebookConfig(env), uri, state),
    connect: async (env, db, uri, code, now) => {
      const cfg = facebook.facebookConfig(env);
      const userToken = await facebook.exchangeCode(cfg, uri, code);
      await saveFacebookPages(db, env, await facebook.listPages(cfg, userToken), now);
    },
  },
  pinterest: {
    authorizeUrl: (env, uri, state) => pinterest.authorizeUrl(pinterest.pinterestConfig(env), uri, state),
    connect: async (env, db, uri, code, now) => {
      const cfg = pinterest.pinterestConfig(env);
      const tokens = await pinterest.exchangeCode(cfg, uri, code, now);
      const username = await pinterest.getUsername(cfg, tokens.accessToken);
      await savePinterestAccount(db, env, username, tokens, await pinterest.listBoards(cfg, tokens.accessToken), now);
    },
  },
  google: {
    authorizeUrl: (env, uri, state) => drive.authorizeUrl(drive.googleConfig(env), uri, state),
    connect: async (env, db, uri, code, now) => {
      const tokens = await drive.exchangeCode(drive.googleConfig(env), uri, code, now);
      await saveGoogleAccount(db, env, await drive.getEmail(tokens.accessToken), tokens, now);
    },
  },
} satisfies Record<string, Connector>;
type Platform = keyof typeof connectors;

function platformParam(c: Context<AppEnv>): Platform {
  const p = c.req.param("platform") ?? "";
  if (!(p in connectors)) throw fail(404, "nền tảng không hỗ trợ");
  return p as Platform;
}

// Phải trùng khớp tuyệt đối với Redirect URI đã khai báo trên Meta/Pinterest/Google.
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
  return c.redirect(connectors[platform].authorizeUrl(c.env, redirectUri(c, platform), state));
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
    await connectors[platform].connect(c.env, db, redirectUri(c, platform), code, now);
  } catch (err) {
    if (!(err instanceof PublishFailure)) throw err;
    log("warn", "oauth_failed", { platform, op: err instanceof PlatformError ? err.op : null });
    return backToAccounts(c, `${platform}: ${err.message}`);
  }
  return backToAccounts(c);
});
