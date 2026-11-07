import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { posts, postTargets } from "../db/schema";

/** Quy tắc duy nhất biến thời điểm đăng thành trạng thái target. */
export function scheduleFields(at: number | null) {
  return at === null
    ? { status: "draft" as const, nextAttemptAt: null }
    : { status: "scheduled" as const, nextAttemptAt: at };
}

/** Nơi duy nhất đổi lịch của bài đã có. Không đụng target đã đăng hoặc đang đăng. */
export async function setSchedule(db: Db, postId: number, at: number | null, now: number) {
  await db.batch([
    db.update(posts).set({ scheduledAt: at, updatedAt: now }).where(eq(posts.id, postId)),
    db
      .update(postTargets)
      .set({
        ...scheduleFields(at),
        attempts: 0,
        lockedAt: null,
        lastError: null,
        needsAttention: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(postTargets.postId, postId),
          notInArray(postTargets.status, ["published", "publishing"]),
        ),
      ),
  ]);
}
