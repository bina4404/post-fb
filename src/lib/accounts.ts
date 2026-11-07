import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, boards } from "../db/schema";
import type { WorkerEnv } from "../env";
import type { FacebookPage } from "../platforms/facebook";
import type { PinterestTokens } from "../platforms/pinterest";
import { encryptToken } from "./crypto";

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
