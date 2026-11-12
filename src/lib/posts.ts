import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, posts, postTargets } from "../db/schema";
import { scheduleFields } from "./schedule";

export type Platform = "facebook";
export type TargetInput = { platform: Platform; accountId: number; key?: string };
export type PostInput = {
  caption: string;
  link: string | null;
  imageKey: string | null;
  imageUrl: string | null;
  scheduledAt: number | null;
  targets: TargetInput[];
};
export type Destinations = { pages: { id: number; name: string; externalId: string }[] };

/** Quy tắc nội dung dùng chung cho API và CSV. Trả về lỗi, hoặc null nếu hợp lệ. */
export function contentError(p: Omit<PostInput, "scheduledAt">): string | null {
  if (p.targets.length === 0) return "cần chọn Page Facebook";
  if (p.imageKey && p.imageUrl) return "chỉ dùng một trong image_key hoặc image_url";
  return null;
}

export async function loadDestinations(db: Db): Promise<Destinations> {
  const pages = await db
    .select({ id: accounts.id, name: accounts.name, externalId: accounts.externalId })
    .from(accounts)
    .where(and(eq(accounts.platform, "facebook"), eq(accounts.enabled, true)));
  return { pages };
}

/** Các dòng post_targets. `postId` có thể là biểu thức SQL khi bài được chèn trong cùng batch. */
export function targetRows(postId: number | SQL, targets: TargetInput[], at: number | null, now: number) {
  return targets.map((t) => ({
    postId,
    platform: t.platform,
    accountId: t.accountId,
    idempotencyKey: t.key ?? sql`${postId} || ${`:${t.platform}:${t.accountId}`}`,
    ...scheduleFields(at),
    updatedAt: now,
  }));
}

// Trong một batch (transaction), ngay sau INSERT posts thì max(id) chính là bài vừa chèn.
const lastPostId = sql`(SELECT max(id) FROM posts)`;

// D1 cho phép tối đa 100 tham số mỗi câu SQL; mỗi target dùng khoảng 10 tham số, nên chèn từng nhóm 6 target.
const TARGETS_PER_INSERT = 6;

/** Câu lệnh chèn các target của một bài, chia nhóm cho vừa giới hạn tham số của D1. Đưa vào cùng db.batch() với bài. */
export function insertTargets(db: Db, postId: number | SQL, targets: TargetInput[], at: number | null, now: number) {
  const rows = targetRows(postId, targets, at, now);
  return Array.from({ length: Math.ceil(rows.length / TARGETS_PER_INSERT) }, (_, i) =>
    db.insert(postTargets).values(rows.slice(i * TARGETS_PER_INSERT, (i + 1) * TARGETS_PER_INSERT)),
  );
}

/** Câu lệnh chèn một bài cùng các target của nó. Đưa vào db.batch() để chạy nguyên tử (batch D1 là một transaction). */
export function insertPost(db: Db, p: PostInput, now: number) {
  const { targets, ...content } = p;
  const post = db.insert(posts).values({ ...content, createdAt: now, updatedAt: now }).returning({ id: posts.id });
  return [post, ...insertTargets(db, lastPostId, targets, p.scheduledAt, now)] as const;
}
