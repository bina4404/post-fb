import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { accounts, postTargets } from "../db/schema";
import type { WorkerEnv } from "../env";
import { log } from "../lib/log";
import type { PublishMessage } from "./publish";

// Lớn hơn thời gian chạy tối đa của một queue consumer (15 phút), nên không còn lệnh gọi nào đang chạy.
export const STUCK_AFTER_MS = 20 * 60_000;
const ENQUEUE_LIMIT = 100;

/** Target kẹt ở publishing: không rõ nền tảng đã nhận bài chưa, nên không tự retry (tránh đăng trùng). */
async function failStuck(db: Db, now: number) {
  const stuck = await db
    .update(postTargets)
    .set({
      status: "failed",
      needsAttention: true,
      lockedAt: null,
      lastError: "không rõ kết quả (Worker dừng giữa lúc đăng), hãy kiểm tra trên nền tảng trước khi đăng lại",
      updatedAt: now,
    })
    .where(and(eq(postTargets.status, "publishing"), lt(postTargets.lockedAt, now - STUCK_AFTER_MS)))
    .returning({ id: postTargets.id });
  for (const t of stuck) log("error", "publish_stuck", { targetId: t.id });
}

/** Đẩy target đến hạn vào queue. Account cần kết nối lại hoặc đang tắt thì target của nó nằm chờ. */
async function enqueueDue(db: Db, env: WorkerEnv, now: number) {
  const due = await db
    .select({ id: postTargets.id })
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
  if (due.length === 0) return;
  await env.PUBLISH_QUEUE.sendBatch(due.map((t) => ({ body: { targetId: t.id } satisfies PublishMessage })));
  log("info", "cron_enqueued", { count: due.length });
}

/** Chạy mỗi phút (wrangler.jsonc triggers.crons). */
export async function runCron(env: WorkerEnv, now = Date.now()) {
  const db = getDb(env);
  await failStuck(db, now);
  await enqueueDue(db, env, now);
}
