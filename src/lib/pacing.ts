// Nhịp đăng bài để giảm rủi ro Facebook coi là spam / hành vi tự động bất thường.
// Không có cách nào bảo đảm không bị hạn chế: đây là các giới hạn an toàn, đổi ở một chỗ duy nhất này.
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { postTargets } from "../db/schema";
import { DAY_MS } from "./time";

/** Khoảng cách tối thiểu giữa 2 bài trên cùng một Page. */
export const PAGE_MIN_GAP_MS = 10 * 60_000;
/** Số bài tối đa trên một Page trong 24 giờ. */
export const PAGE_DAILY_CAP = 25;
/** Cùng một bài đăng lên nhiều Page: các Page cách nhau ngẫu nhiên 30–90 giây, không đăng đồng loạt. */
export const STAGGER_MIN_S = 30;
export const STAGGER_MAX_S = 90;
/** Độ lệch ngẫu nhiên 0–30 giây cho lần gửi đầu, để bài không luôn rơi đúng giây :00. */
export const JITTER_S = 30;
/** Facebook báo vượt giới hạn gọi API: chờ 15, 30, 60 phút (thay vì 2, 4, 8 phút như lỗi tạm thời thường). */
export const rateLimitBackoffMs = (attempts: number) => 15 * 60_000 * 2 ** (attempts - 1);

const randomInt = (max: number, random: () => number) => Math.floor(random() * (max + 1));

/** Độ trễ (giây) cho từng target: Page đầu tiên của mỗi bài trễ 0–JITTER_S, mỗi Page tiếp theo cộng thêm 30–90 giây. */
export function staggerDelays(targets: { id: number; postId: number }[], random = Math.random): { id: number; delay: number }[] {
  const lastDelay = new Map<number, number>();
  return targets.map((t) => {
    const prev = lastDelay.get(t.postId);
    const delay = prev === undefined ? randomInt(JITTER_S, random) : prev + STAGGER_MIN_S + randomInt(STAGGER_MAX_S - STAGGER_MIN_S, random);
    lastDelay.set(t.postId, delay);
    return { id: t.id, delay };
  });
}

/**
 * Thời điểm sớm nhất được đăng tiếp lên Page `accountId`, hoặc null nếu đăng ngay được.
 * Tính cả bài khác đang đăng dở trên cùng Page, để hai consumer chạy song song không đăng dồn.
 */
export async function pageReadyAt(db: Db, accountId: number, exceptTargetId: number, now: number): Promise<number | null> {
  const recent = await db
    .select({ at: postTargets.updatedAt })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.accountId, accountId),
        ne(postTargets.id, exceptTargetId),
        inArray(postTargets.status, ["published", "publishing"]),
        gt(postTargets.updatedAt, now - DAY_MS),
      ),
    )
    .orderBy(desc(postTargets.updatedAt));
  if (recent.length >= PAGE_DAILY_CAP) return recent[PAGE_DAILY_CAP - 1]!.at + DAY_MS;
  const last = recent[0]?.at;
  return last !== undefined && now - last < PAGE_MIN_GAP_MS ? last + PAGE_MIN_GAP_MS : null;
}
