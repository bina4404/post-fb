import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { accounts, postTargets } from "../db/schema";
import type { WorkerEnv } from "../env";
import { log } from "../lib/log";
import { staggerDelays } from "../lib/pacing";
import { appTimeZone } from "../lib/settings";
import { planAutoPosts } from "./planner";
import type { PublishMessage } from "./publish";

// Lớn hơn thời gian chạy tối đa của một queue consumer (15 phút), nên không còn lệnh gọi nào đang chạy.
export const STUCK_AFTER_MS = 20 * 60_000;
/** Lỗi của target kẹt: có thể bài ĐÃ lên Facebook. Chỉ người dùng (nút "Đăng lại") mới được đẩy lại target này. */
export const UNKNOWN_OUTCOME_ERROR = "không rõ kết quả (Worker dừng giữa lúc đăng), hãy kiểm tra trên nền tảng trước khi đăng lại";
const ENQUEUE_LIMIT = 100;

/** Target kẹt ở publishing: không rõ nền tảng đã nhận bài chưa, nên không tự retry (tránh đăng trùng). */
async function failStuck(db: Db, now: number) {
  const stuck = await db
    .update(postTargets)
    .set({
      status: "failed",
      needsAttention: true,
      lockedAt: null,
      lastError: UNKNOWN_OUTCOME_ERROR,
      updatedAt: now,
    })
    .where(and(eq(postTargets.status, "publishing"), lt(postTargets.lockedAt, now - STUCK_AFTER_MS)))
    .returning({ id: postTargets.id });
  for (const t of stuck) log("error", "publish_stuck", { targetId: t.id });
}

/** Đẩy target đến hạn vào queue. Account cần kết nối lại hoặc đang tắt thì target của nó nằm chờ. */
/**
 * Đẩy target vào queue với độ trễ giãn cách (staggerDelays). Đồng thời dời next_attempt_at tới đúng giờ gửi,
 * để cron phút sau không đẩy lại sớm hơn và làm mất giãn cách. Message trùng vẫn an toàn nhờ claim nguyên tử.
 */
export async function enqueueTargets(db: Db, env: WorkerEnv, targets: { id: number; postId: number }[], now: number) {
  const plan = staggerDelays(targets);
  const [first, ...rest] = plan.map((p) =>
    db.update(postTargets).set({ nextAttemptAt: now + p.delay * 1000 }).where(and(eq(postTargets.id, p.id), eq(postTargets.status, "scheduled"))),
  );
  if (!first) return;
  await db.batch([first, ...rest]);
  await env.PUBLISH_QUEUE.sendBatch(plan.map((p) => ({ body: { targetId: p.id } satisfies PublishMessage, delaySeconds: p.delay })));
}

async function enqueueDue(db: Db, env: WorkerEnv, now: number) {
  const due = await db
    .select({ id: postTargets.id, postId: postTargets.postId, accountId: postTargets.accountId })
    .from(postTargets)
    .innerJoin(accounts, eq(accounts.id, postTargets.accountId))
    .where(
      and(
        eq(postTargets.status, "scheduled"),
        lte(postTargets.nextAttemptAt, now),
        eq(accounts.status, "ok"),
        eq(accounts.enabled, true),
        isNotNull(accounts.accessTokenEnc),
      ),
    )
    .orderBy(postTargets.nextAttemptAt)
    .limit(ENQUEUE_LIMIT);
  // Mỗi Page tối đa 1 bài mỗi lượt cron; bài còn lại đi ở lượt sau (và còn qua kiểm tra giãn cách khi đăng).
  const seen = new Set<number>();
  const onePerPage = due.filter((t) => !seen.has(t.accountId) && seen.add(t.accountId));
  if (onePerPage.length === 0) return;
  await enqueueTargets(db, env, onePerPage, now);
  log("info", "cron_enqueued", { count: onePerPage.length });
}

/** Chạy mỗi phút (wrangler.jsonc triggers.crons). */
export async function runCron(env: WorkerEnv, now = Date.now()) {
  const db = getDb(env);
  await failStuck(db, now);
  await enqueueDue(db, env, now);
  if (new Date(now).getUTCMinutes() === 0) {
    try {
      await planAutoPosts(db, now, await appTimeZone(db));
    } catch (err) {
      log("error", "autoplan_failed", { message: (err as Error).message });
    }
  }
}
