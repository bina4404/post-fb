import { and, eq, lte, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { accounts, posts, postTargets } from "../db/schema";
import type { WorkerEnv } from "../env";
import { decryptToken } from "../lib/crypto";
import { loadImage } from "../lib/image";
import { JITTER_S, pageReadyAt, rateLimitBackoffMs } from "../lib/pacing";
import { log } from "../lib/log";
import { PublishFailure } from "../platforms/errors";
import * as facebook from "../platforms/facebook";

export const MAX_RETRIES = 3;
export const backoffMs = (attempts: number) => 2 ** attempts * 60_000; // 2, 4, 8 phút

type Target = typeof postTargets.$inferSelect;
export type PublishResult = "skipped" | "published" | "retry" | "failed" | "waiting";

/**
 * Giành target bằng một câu UPDATE nguyên tử. Message trùng, cron chạy trùng hay hai consumer song song
 * đều chỉ có một bên nhận được dòng trả về, nên mỗi lần đăng chỉ được gọi một lần.
 */
async function claim(db: Db, targetId: number, now: number): Promise<Target | undefined> {
  const [target] = await db
    .update(postTargets)
    .set({ status: "publishing", attempts: sql`${postTargets.attempts} + 1`, lockedAt: now, updatedAt: now })
    .where(and(eq(postTargets.id, targetId), eq(postTargets.status, "scheduled"), lte(postTargets.nextAttemptAt, now)))
    .returning();
  return target;
}

async function send(env: WorkerEnv, db: Db, target: Target): Promise<string | null> {
  const post = (await db.select().from(posts).where(eq(posts.id, target.postId)))[0]!;
  const account = (await db.select().from(accounts).where(eq(accounts.id, target.accountId)))[0]!;
  // Bị ngắt kết nối giữa lúc cron đẩy việc và lúc consumer chạy: trả về null để target nằm chờ.
  if (!account.accessTokenEnc || account.status !== "ok" || !account.enabled) return null;
  const token = await decryptToken(account.accessTokenEnc, env.TOKEN_ENC_KEY);
  const image = await loadImage(env, post);
  return facebook.publishPost(facebook.facebookConfig(env), account.externalId, token, { caption: post.caption, link: post.link, image });
}

async function recordFailure(db: Db, target: Target, err: PublishFailure, now: number): Promise<PublishResult> {
  const base = { lockedAt: null, lastError: err.message, updatedAt: now };
  const retryable = err.kind === "transient" || err.kind === "rate_limited";
  if (retryable && target.attempts <= MAX_RETRIES) {
    const wait = err.kind === "rate_limited" ? rateLimitBackoffMs(target.attempts) : backoffMs(target.attempts);
    await db.update(postTargets).set({ ...base, status: "scheduled", nextAttemptAt: now + wait }).where(eq(postTargets.id, target.id));
    return "retry";
  }
  await db.update(postTargets).set({ ...base, status: "failed", needsAttention: true }).where(eq(postTargets.id, target.id));
  // Token hỏng / Page bị chặn: các bài khác của Page này nằm chờ (cron chỉ lấy account 'ok') cho tới khi kết nối lại.
  const pause = err.kind === "auth" ? "needs_reauth" : err.kind === "blocked" ? "paused" : null;
  if (pause) await db.update(accounts).set({ status: pause, updatedAt: now }).where(eq(accounts.id, target.accountId));
  return "failed";
}

export async function publishTarget(env: WorkerEnv, targetId: number, now = Date.now()): Promise<PublishResult> {
  const db = getDb(env);
  const target = await claim(db, targetId, now);
  if (!target) return "skipped";

  // Giãn cách theo Page: chưa tới lượt thì trả target về hàng đợi, không tính là một lần thử.
  const readyAt = await pageReadyAt(db, target.accountId, target.id, now);
  if (readyAt !== null) {
    const nextAttemptAt = readyAt + Math.floor(Math.random() * JITTER_S * 1000);
    await db.update(postTargets).set({ status: "scheduled", attempts: target.attempts - 1, nextAttemptAt, lockedAt: null, updatedAt: now }).where(eq(postTargets.id, target.id));
    log("info", "publish_paced", { targetId, accountId: target.accountId, nextAttemptAt });
    return "waiting";
  }

  let externalId: string | null;
  try {
    externalId = await send(env, db, target);
  } catch (err) {
    if (!(err instanceof PublishFailure)) throw err; // lỗi lạ: target nằm ở publishing, cron đánh dấu "cần xử lý" sau 20 phút
    const result = await recordFailure(db, target, err, now);
    log(result === "retry" ? "warn" : "error", "publish_" + result, { targetId, platform: target.platform, attempts: target.attempts, kind: err.kind, message: err.message });
    return result;
  }
  if (externalId === null) {
    await db.update(postTargets).set({ status: "scheduled", attempts: target.attempts - 1, lockedAt: null, updatedAt: now }).where(eq(postTargets.id, target.id));
    return "waiting";
  }
  await db
    .update(postTargets)
    .set({ status: "published", externalPostId: externalId, lockedAt: null, lastError: null, needsAttention: false, updatedAt: now })
    .where(eq(postTargets.id, target.id));
  log("info", "publish_published", { targetId, platform: target.platform, externalId });
  return "published";
}

export type PublishMessage = { targetId: number };

/** Consumer của queue. Luôn ack: việc thử lại do DB (next_attempt_at) và cron lo, không dùng retry của Queue. */
export async function handleQueue(batch: MessageBatch<PublishMessage>, env: WorkerEnv) {
  for (const msg of batch.messages) {
    try {
      await publishTarget(env, msg.body.targetId);
    } catch (err) {
      log("error", "publish_crashed", { targetId: msg.body.targetId, message: (err as Error).message });
    }
    msg.ack();
  }
}
