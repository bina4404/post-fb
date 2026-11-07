import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, boards } from "../db/schema";
import type { WorkerEnv } from "../env";
import { googleConfig, refreshAccessToken, type GoogleTokens } from "../platforms/drive";
import { PlatformError, PublishFailure } from "../platforms/errors";
import type { FacebookPage } from "../platforms/facebook";
import type { PinterestTokens } from "../platforms/pinterest";
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

export async function savePinterestTokens(db: Db, env: WorkerEnv, accountId: number, t: PinterestTokens, now: number) {
  await db
    .update(accounts)
    .set({
      accessTokenEnc: await encryptToken(t.accessToken, env.TOKEN_ENC_KEY),
      refreshTokenEnc: await encryptToken(t.refreshToken, env.TOKEN_ENC_KEY),
      accessExpiresAt: t.accessExpiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
      status: "ok",
      updatedAt: now,
    })
    .where(eq(accounts.id, accountId));
}

/** Lưu tài khoản Pinterest (theo username), token và các board. Board mới có enabled=false. */
export async function savePinterestAccount(
  db: Db,
  env: WorkerEnv,
  username: string,
  tokens: PinterestTokens,
  boardList: { id: string; name: string }[],
  now: number,
) {
  const [account] = await db
    .insert(accounts)
    .values({ platform: "pinterest", externalId: username, name: username, updatedAt: now })
    .onConflictDoUpdate({ target: [accounts.platform, accounts.externalId], set: { updatedAt: now } })
    .returning({ id: accounts.id });
  await savePinterestTokens(db, env, account!.id, tokens, now);
  for (const b of boardList) {
    await db
      .insert(boards)
      .values({ accountId: account!.id, externalId: b.id, name: b.name })
      .onConflictDoUpdate({ target: [boards.accountId, boards.externalId], set: { name: b.name } });
  }
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
