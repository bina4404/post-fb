import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";
import type { WorkerEnv } from "../env";
import { savePinterestTokens } from "../lib/accounts";
import { decryptToken } from "../lib/crypto";
import { log } from "../lib/log";
import { PlatformError } from "../platforms/errors";
import { pinterestConfig, refreshTokens } from "../platforms/pinterest";

export const REFRESH_MARGIN_MS = 3 * 86_400_000;

/**
 * Refresh token Pinterest còn dưới 3 ngày. Chỉ cron gọi hàm này: mỗi lần refresh sinh refresh token mới,
 * nên hai nơi refresh song song sẽ làm một bên nhận 401.
 */
export async function refreshPinterestTokens(db: Db, env: WorkerEnv, now: number) {
  const due = await db
    .select({ id: accounts.id, refreshTokenEnc: accounts.refreshTokenEnc })
    .from(accounts)
    .where(
      and(
        eq(accounts.platform, "pinterest"),
        eq(accounts.status, "ok"),
        isNotNull(accounts.refreshTokenEnc),
        lt(accounts.accessExpiresAt, now + REFRESH_MARGIN_MS),
      ),
    );
  for (const account of due) {
    try {
      const refreshToken = await decryptToken(account.refreshTokenEnc!, env.TOKEN_ENC_KEY);
      const tokens = await refreshTokens(pinterestConfig(env), refreshToken, now);
      await savePinterestTokens(db, env, account.id, tokens, now);
      log("info", "pinterest_token_refreshed", { accountId: account.id });
    } catch (err) {
      if (!(err instanceof PlatformError)) throw err;
      // Lỗi tạm thời: phút sau cron thử lại. Lỗi khác: cần người dùng kết nối lại.
      if (err.kind !== "transient") {
        await db.update(accounts).set({ status: "needs_reauth", updatedAt: now }).where(eq(accounts.id, account.id));
      }
    }
  }
}
