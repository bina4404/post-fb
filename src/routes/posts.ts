import { desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, type Db } from "../db/client";
import { posts, postTargets } from "../db/schema";
import type { AppEnv } from "../env";
import { fail, idParam, readJson } from "../lib/http";
import { contentError, insertPost, loadDestinations, targetRows, type TargetInput } from "../lib/posts";
import { parseScheduleTime } from "../lib/time";

const postBody = z.object({
  caption: z.string().trim().min(1),
  link: z.url({ protocol: /^https?$/ }).nullish(),
  imageKey: z.uuid().nullish(),
  imageUrl: z.url({ protocol: /^https$/ }).nullish(),
  facebookAccountId: z.int().positive().nullish(),
  pinterestBoardId: z.int().positive().nullish(),
  scheduledAt: z.string().nullish(),
});
const contentBody = postBody.omit({ scheduledAt: true });
type PostBody = z.infer<typeof postBody>;

async function toInput(db: Db, body: PostBody, now: number) {
  const dest = await loadDestinations(db);
  const targets: TargetInput[] = [];
  if (body.facebookAccountId) {
    if (!dest.pages.some((p) => p.id === body.facebookAccountId)) throw fail(400, "Page Facebook không có hoặc chưa bật");
    targets.push({ platform: "facebook", accountId: body.facebookAccountId, boardId: null });
  }
  if (body.pinterestBoardId) {
    const board = dest.boards.find((b) => b.id === body.pinterestBoardId);
    if (!board) throw fail(400, "Board Pinterest không có hoặc chưa bật");
    targets.push({ platform: "pinterest", accountId: board.accountId, boardId: board.id });
  }
  const scheduledAt = body.scheduledAt ? parseScheduleTime(body.scheduledAt) : null;
  if (body.scheduledAt && (scheduledAt === null || scheduledAt <= now)) {
    throw fail(400, "scheduledAt phải là thời điểm hợp lệ trong tương lai");
  }
  const input = {
    caption: body.caption,
    link: body.link ?? null,
    imageKey: body.imageKey ?? null,
    imageUrl: body.imageUrl ?? null,
    scheduledAt,
    targets,
  };
  const error = contentError(input);
  if (error) throw fail(400, error);
  return input;
}

export async function loadPost(db: Db, id: number) {
  const post = await db.query.posts.findFirst({ where: eq(posts.id, id) });
  if (!post) throw fail(404, "không tìm thấy bài");
  const targets = await db.select().from(postTargets).where(eq(postTargets.postId, id));
  return { ...post, targets };
}

/** Bài có target đang đăng hoặc đã đăng thì không được sửa hoặc xoá. */
function assertEditable(post: Awaited<ReturnType<typeof loadPost>>) {
  if (post.targets.some((t) => t.status === "publishing" || t.status === "published")) {
    throw fail(409, "bài đã hoặc đang được đăng, không sửa/xoá được");
  }
}

export const postRoutes = new Hono<AppEnv>();

postRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  // shortcut: 200 bài mới nhất, không phân trang; thêm phân trang khi thư viện lớn hơn.
  const list = await db.select().from(posts).orderBy(desc(sql`coalesce(${posts.scheduledAt}, ${posts.createdAt})`)).limit(200);
  const ids = list.map((p) => p.id);
  const targets = ids.length ? await db.select().from(postTargets).where(inArray(postTargets.postId, ids)) : [];
  return c.json(list.map((p) => ({ ...p, targets: targets.filter((t) => t.postId === p.id) })));
});

postRoutes.post("/", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const input = await toInput(db, await readJson(c, postBody), now);
  const [inserted] = await db.batch(insertPost(db, input, now));
  return c.json(await loadPost(db, inserted[0]!.id), 201);
});

postRoutes.get("/:id", async (c) => c.json(await loadPost(getDb(c.env), idParam(c))));

postRoutes.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = idParam(c);
  const now = Date.now();
  const post = await loadPost(db, id);
  assertEditable(post);
  // Lịch chỉ đổi qua /schedule, nên body PATCH không có scheduledAt và giữ lịch cũ.
  const input = await toInput(db, await readJson(c, contentBody), now);
  const { caption, link, imageKey, imageUrl } = input;
  await db.batch([
    db.update(posts).set({ caption, link, imageKey, imageUrl, updatedAt: now }).where(eq(posts.id, id)),
    db.delete(postTargets).where(eq(postTargets.postId, id)),
    db.insert(postTargets).values(targetRows(id, input.targets, post.scheduledAt, now)),
  ]);
  if (post.imageKey && post.imageKey !== imageKey) await c.env.MEDIA.delete(post.imageKey);
  return c.json(await loadPost(db, id));
});

postRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const post = await loadPost(db, idParam(c));
  assertEditable(post);
  await db.delete(posts).where(eq(posts.id, post.id));
  if (post.imageKey) await c.env.MEDIA.delete(post.imageKey);
  return c.body(null, 204);
});
