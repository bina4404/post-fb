// Đo hiệu quả: 7 ngày sau khi đăng, lấy lượt xem (và lượt theo dõi với Reels) từ Facebook cho từng target.
// Bộ lập lịch dùng số này để chọn chủ đề hay được xem hơn (lib/autoplan.ts topicWeights).
import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, posts, postTargets } from "../db/schema";
import type { WorkerEnv } from "../env";
import { decryptToken } from "../lib/crypto";
import { log } from "../lib/log";
import { DAY_MS } from "../lib/time";
import * as facebook from "../platforms/facebook";

/** Báo cáo phân tích page dùng mốc "lượt xem sau 7 ngày". */
export const MEASURE_AFTER_MS = 7 * DAY_MS;
/** Quá 30 ngày mà vẫn chưa đo được (thiếu quyền, bài bị xoá) thì thôi. */
export const GIVE_UP_AFTER_MS = 30 * DAY_MS;
const PER_RUN = 50;

export async function collectInsights(db: Db, env: WorkerEnv, now: number) {
  const due = await db
    .select({
      id: postTargets.id,
      externalPostId: postTargets.externalPostId,
      accountId: postTargets.accountId,
      kind: posts.kind,
      tokenEnc: accounts.accessTokenEnc,
    })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .innerJoin(accounts, eq(accounts.id, postTargets.accountId))
    .where(
      and(
        eq(postTargets.status, "published"),
        isNotNull(postTargets.externalPostId),
        isNull(postTargets.statsAt),
        lte(posts.scheduledAt, now - MEASURE_AFTER_MS),
        gte(posts.scheduledAt, now - GIVE_UP_AFTER_MS),
        eq(accounts.status, "ok"),
        isNotNull(accounts.accessTokenEnc),
      ),
    )
    .orderBy(posts.scheduledAt)
    .limit(PER_RUN);

  const cfg = facebook.facebookConfig(env);
  const failedPages = new Set<number>();
  let measured = 0;
  for (const t of due) {
    if (failedPages.has(t.accountId)) continue;
    try {
      const stats = await facebook.postInsights(cfg, await decryptToken(t.tokenEnc!, env.TOKEN_ENC_KEY), t.externalPostId!, t.kind);
      if (!stats) continue;
      // Không đổi updated_at: giãn cách đọc cột này như giờ đăng.
      await db.update(postTargets).set({ views: stats.views, follows: stats.follows, statsAt: now }).where(eq(postTargets.id, t.id));
      measured++;
    } catch (err) {
      // Thiếu quyền / token hỏng / giới hạn gọi: bài khác của Page này cũng sẽ lỗi, để lượt sau.
      failedPages.add(t.accountId);
      log("warn", "insights_failed", { targetId: t.id, accountId: t.accountId, message: (err as Error).message });
    }
  }
  if (measured) log("info", "insights_collected", { measured, due: due.length });
  return { measured, due: due.length };
}
