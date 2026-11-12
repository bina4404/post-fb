import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";
import type { WorkerEnv } from "../env";
import { googleConfig, refreshAccessToken, type GoogleTokens } from "../platforms/drive";
import { PlatformError, PublishFailure } from "../platforms/errors";
import type { FacebookPage } from "../platforms/facebook";
import { decryptToken, encryptToken } from "./crypto";

/** Lưu hoặc cập nhật các Page. Page mới có enabled=false để người dùng tự chọn; kết nối lại thì status về 'ok'. */
export async function saveFacebookPages(db: Db, env: WorkerEnv, pages: FacebookPage[], now: number) {
  for (const page of pages) {
    const accessTokenEnc = await encryptToken(page.accessToken, env.TOKEN_ENC_KEY);
    await db
      .insert(accounts)
      .values({ platform: "facebook", externalId: page.id, name: page.name, accessTokenEnc, updatedAt: now })
      .onConflictDoUpdate({
        target: [accounts.platform, accounts.externalId],
        set: { name: page.name, accessTokenEnc, status: "ok", updatedAt: now },
      });
  }
}

/** Tên hiển thị: Page trùng tên thì thêm ID Facebook để phân biệt trên giao diện. */
export function withDistinctNames<T extends { name: string; externalId: string }>(rows: T[]): T[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return rows.map((r) => (count.get(r.name)! > 1 ? { ...r, name: `${r.name} (ID ${r.externalId})` } : r));
}

/** Lưu tài khoản Google Drive (theo email). Kết nối lại thì cập nhật token và đưa status về 'ok'. */
export async function saveGoogleAccount(db: Db, env: WorkerEnv, email: string, t: GoogleTokens, now: number) {
  if (!t.refreshToken) throw new PublishFailure("permanent", "Google không trả refresh token, hãy kết nối lại");
  const tokens = {
    accessTokenEnc: await encryptToken(t.accessToken, env.TOKEN_ENC_KEY),
    refreshTokenEnc: await encryptToken(t.refreshToken, env.TOKEN_ENC_KEY),
    accessExpiresAt: t.accessExpiresAt,
    enabled: true,
    status: "ok" as const,
    updatedAt: now,
  };
  await db
    .insert(accounts)
    .values({ platform: "google", externalId: email, name: email, ...tokens })
    .onConflictDoUpdate({ target: [accounts.platform, accounts.externalId], set: tokens });
}

const ACCESS_MARGIN_MS = 60_000;

/**
 * Access token Google Drive còn hạn, tự refresh khi sắp hết (token sống 1 giờ).
 * Google không xoay vòng refresh token, nên refresh ngay lúc cần là an toàn kể cả khi chạy song song.
 * shortcut: dùng tài khoản Google đầu tiên đang kết nối; thêm chọn tài khoản nếu cần nhiều Drive.
 */
export async function driveAccessToken(db: Db, env: WorkerEnv, now: number): Promise<string> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.platform, "google"), eq(accounts.status, "ok"), isNotNull(accounts.refreshTokenEnc)))
    .limit(1);
  if (!account) throw new PublishFailure("permanent", "chưa kết nối Google Drive (hoặc cần kết nối lại)");
  if (account.accessTokenEnc && (account.accessExpiresAt ?? 0) > now + ACCESS_MARGIN_MS) {
    return decryptToken(account.accessTokenEnc, env.TOKEN_ENC_KEY);
  }
  try {
    const refreshToken = await decryptToken(account.refreshTokenEnc!, env.TOKEN_ENC_KEY);
    const t = await refreshAccessToken(googleConfig(env), refreshToken, now);
    await db
      .update(accounts)
      .set({ accessTokenEnc: await encryptToken(t.accessToken, env.TOKEN_ENC_KEY), accessExpiresAt: t.accessExpiresAt, updatedAt: now })
      .where(eq(accounts.id, account.id));
    return t.accessToken;
  } catch (err) {
    if (err instanceof PlatformError && err.kind === "auth") {
      await db.update(accounts).set({ status: "needs_reauth", updatedAt: now }).where(eq(accounts.id, account.id));
      throw new PublishFailure("permanent", "Google Drive cần kết nối lại");
    }
    throw err;
  }
}
