// Thư viện bài: phân nhóm theo trạng thái, đếm từng nhóm, lọc, sắp xếp và phân trang ngay trong SQL,
// để vẫn nhanh khi có hàng nghìn bài (dùng index post_targets(post_id, status)).
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { posts, postTargets } from "../db/schema";

export const POST_GROUPS = ["draft", "scheduled", "failed", "published"] as const;
export type PostGroup = (typeof POST_GROUPS)[number];
export const PAGE_SIZE = 50;

const hasTarget = (statuses: string[]) =>
  sql`EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id = ${posts.id} AND t.status IN (${sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  )}))`;

/**
 * Nhóm của một bài (một bài có thể đăng lên nhiều Page, mỗi Page một trạng thái):
 * có Page lỗi → failed; còn Page chờ/đang đăng → scheduled; còn Page nháp → draft; còn lại (đã đăng hết) → published.
 */
export const postGroup = sql<PostGroup>`CASE
  WHEN ${hasTarget(["failed"])} THEN 'failed'
  WHEN ${hasTarget(["scheduled", "publishing"])} THEN 'scheduled'
  WHEN ${hasTarget(["draft"])} THEN 'draft'
  ELSE 'published' END`;

// Mỗi nhóm một thứ tự dễ làm việc nhất: bài sắp đăng lên trước; nháp/lỗi mới sửa lên trước; đã đăng mới nhất lên trước.
const ORDER: Record<PostGroup | "all", SQL[]> = {
  scheduled: [asc(posts.scheduledAt), asc(posts.id)],
  draft: [desc(posts.updatedAt), desc(posts.id)],
  failed: [desc(posts.updatedAt), desc(posts.id)],
  published: [desc(sql`coalesce(${posts.scheduledAt}, ${posts.createdAt})`), desc(posts.id)],
  all: [desc(sql`coalesce(${posts.scheduledAt}, ${posts.createdAt})`), desc(posts.id)],
};

export type LibraryQuery = { group?: PostGroup; pageId?: number; q?: string; offset: number };

export async function listLibrary(db: Db, query: LibraryQuery) {
  const filters: SQL[] = [];
  if (query.pageId) filters.push(sql`EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id = ${posts.id} AND t.account_id = ${query.pageId})`);
  // instr thay cho LIKE để không phải thoát ký tự % _ trong từ khoá. lower() của SQLite chỉ hạ chữ ASCII.
  if (query.q) filters.push(sql`instr(lower(${posts.caption}), lower(${query.q})) > 0`);
  const inGroup = query.group ? [...filters, sql`${postGroup} = ${query.group}`] : filters;

  const [countRows, items] = await Promise.all([
    db.select({ group: postGroup, n: sql<number>`count(*)` }).from(posts).where(and(...filters)).groupBy(postGroup),
    db.select().from(posts).where(and(...inGroup)).orderBy(...ORDER[query.group ?? "all"]).limit(PAGE_SIZE).offset(query.offset),
  ]);
  const counts = Object.fromEntries(POST_GROUPS.map((g) => [g, 0])) as Record<PostGroup, number>;
  for (const row of countRows) counts[row.group] = Number(row.n);
  const all = POST_GROUPS.reduce((sum, g) => sum + counts[g], 0);

  const ids = items.map((p) => p.id);
  const targets = ids.length ? await db.select().from(postTargets).where(inArray(postTargets.postId, ids)) : [];
  return {
    items: items.map((p) => ({ ...p, targets: targets.filter((t) => t.postId === p.id) })),
    counts: { ...counts, all },
    total: query.group ? counts[query.group] : all,
    pageSize: PAGE_SIZE,
  };
}

/** Bài còn Page chưa đi (nháp hoặc đã lên lịch): mới có ý nghĩa khi xếp khung giờ. */
export async function hasPendingTarget(db: Db, postId: number) {
  const [row] = await db
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(and(eq(postTargets.postId, postId), inArray(postTargets.status, ["draft", "scheduled"])))
    .limit(1);
  return Boolean(row);
}
