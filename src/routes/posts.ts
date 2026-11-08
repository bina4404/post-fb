import { desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, type Db } from "../db/client";
import { posts, postTargets } from "../db/schema";
import type { AppEnv } from "../env";
import { fail, idParam, readJson } from "../lib/http";
import { contentError, insertPost, loadDestinations, targetRows, type TargetInput } from "../lib/posts";
import { parseScheduleTime } from "../lib/time";
import { UNKNOWN_OUTCOME_ERROR } from "../jobs/cron";
import { driveFileId } from "../platforms/drive";

const postBody = z.object({
  caption: z.string().trim().min(1),
  link: z.url({ protocol: /^https?$/ }).nullish(),
  imageKey: driveFileId.nullish(),
  imageUrl: z.url({ protocol: /^https$/ }).nullish(),
  facebookAccountIds: z.array(z.int().positive()).min(1, "chọn ít nhất 1 Page Facebook").max(50),
  scheduledAt: z.string().nullish(),
});
const contentBody = postBody.omit({ scheduledAt: true });
type PostBody = z.infer<typeof postBody>;

async function toInput(db: Db, body: PostBody, now: number) {
  const dest = await loadDestinations(db);
  const pageIds = [...new Set(body.facebookAccountIds)];
  if (!pageIds.every((id) => dest.pages.some((p) => p.id === id))) throw fail(400, "có Page Facebook không tồn tại hoặc chưa bật");
  // Mỗi Page là một target riêng: cùng nội dung, đăng và theo dõi trạng thái độc lập trên từng Page.
  const targets: TargetInput[] = pageIds.map((accountId) => ({ platform: "facebook", accountId }));
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

/** Sửa bài tạo lại mọi target. Target "không rõ kết quả" có thể đã lên Facebook, tạo lại sẽ đăng trùng. */
function assertNoUnknownOutcome(post: Awaited<ReturnType<typeof loadPost>>) {
  if (post.targets.some((t) => t.status === "failed" && t.lastError === UNKNOWN_OUTCOME_ERROR)) {
    throw fail(409, "có Page không rõ đã đăng hay chưa: kiểm tra trên Facebook, rồi dùng Đăng lại hoặc xoá bài");
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
  assertNoUnknownOutcome(post);
  // Lịch chỉ đổi qua /schedule, nên body PATCH không có scheduledAt và giữ lịch cũ.
  const input = await toInput(db, await readJson(c, contentBody), now);
  const { caption, link, imageKey, imageUrl } = input;
  await db.batch([
    db.update(posts).set({ caption, link, imageKey, imageUrl, updatedAt: now }).where(eq(posts.id, id)),
    db.delete(postTargets).where(eq(postTargets.postId, id)),
    db.insert(postTargets).values(targetRows(id, input.targets, post.scheduledAt, now)),
  ]);
  return c.json(await loadPost(db, id));
});

postRoutes.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const post = await loadPost(db, idParam(c));
  assertEditable(post);
  // Ảnh giữ lại trong thư mục post-fb trên Drive để dùng cho bài khác.
  await db.delete(posts).where(eq(posts.id, post.id));
  return c.body(null, 204);
});
