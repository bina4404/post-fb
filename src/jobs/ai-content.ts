// AI gợi ý nội dung: caption cho ảnh/video trong kho và bài chữ hỏi fan. Mọi thứ AI viết nằm ở `suggestions`,
// chỉ vào lịch sau khi bạn duyệt (chuyển sang `captions`).
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { images, pageTimes, posts, topics } from "../db/schema";
import type { WorkerEnv } from "../env";
import { driveAccessToken } from "../lib/accounts";
import { log } from "../lib/log";
import { DAY_MS } from "../lib/time";
import { downloadThumbnail } from "../platforms/drive";
import { PublishFailure } from "../platforms/errors";
import { writePosts } from "../platforms/claude";

/** Bằng MAX_CAPTIONS của kho: mỗi media giữ tối đa 10 gợi ý chờ duyệt. */
export const MAX_SUGGESTIONS = 10;
const CAPTIONS_PER_CALL = 3;
const FAN_POSTS_PER_CALL = 4;
/** Mỗi lượt cron (mỗi giờ) gọi Claude tối đa bấy nhiêu lần cho caption: giới hạn chi phí. */
const AUTO_MEDIA_PER_RUN = 3;
/** Bạn bỏ hết gợi ý thì 7 ngày sau AI mới gợi ý lại cho media đó. */
const RESUGGEST_AFTER_MS = 7 * DAY_MS;
/** Kho còn ít hơn bấy nhiêu bài hỏi fan đã duyệt mà chưa đăng thì AI viết thêm. */
const MIN_READY_FAN_POSTS = 4;
const MAX_LEN = 2000;

function requireKey(env: WorkerEnv): string {
  if (!env.ANTHROPIC_API_KEY) throw new PublishFailure("permanent", "chưa cấu hình ANTHROPIC_API_KEY nên chưa dùng được AI");
  return env.ANTHROPIC_API_KEY;
}

/** Bỏ bài trùng (với nhau và với `existing`) và bài quá dài. */
const fresh = (texts: string[], existing: string[]) => {
  const seen = new Set(existing);
  return texts.filter((t) => t.length <= MAX_LEN && !seen.has(t) && seen.add(t));
};

/** Ảnh nhỏ của media để AI nhìn thấy nội dung. Lỗi Drive thì AI chỉ dựa vào tên file và chủ đề. */
async function thumbnail(db: Db, env: WorkerEnv, fileId: string, now: number) {
  try {
    return await downloadThumbnail(await driveAccessToken(db, env, now), fileId);
  } catch (err) {
    log("warn", "ai_thumbnail_skipped", { message: (err as Error).message });
    return null;
  }
}

/** AI viết thêm 3 caption gợi ý cho một ảnh/video trong kho. Trả về dòng kho sau khi cập nhật. */
export async function suggestCaptions(db: Db, env: WorkerEnv, imageId: number, now: number) {
  const apiKey = requireKey(env);
  const row = await db.select().from(images).leftJoin(topics, eq(topics.id, images.topicId)).where(eq(images.id, imageId)).get();
  if (!row) throw new PublishFailure("permanent", "không tìm thấy media");
  const { images: img, topics: topic } = row;
  if (img.kind === "text") throw new PublishFailure("permanent", "bài chữ không cần caption, hãy dùng \"AI viết bài hỏi fan\"");
  const known = [...img.captions, ...img.suggestions];
  const task = [
    topic ? `Topic: ${topic.name}. ${topic.brief}` : "Topic: not set. Infer it from the file name and the picture.",
    `Format: ${img.kind === "reel" ? "caption for a Reel (short vertical video); the video itself tells the story, the caption adds the hook and the debate question" : "caption for a photo post"}.`,
    `File name (often the working title): ${img.name}`,
    known.length ? `Existing captions, do not repeat or paraphrase them:\n${known.map((c) => `- ${c}`).join("\n")}` : "",
    `Write ${CAPTIONS_PER_CALL} new captions, 40-120 words each, with at most 3 relevant hashtags at the end of each.`,
  ].filter(Boolean).join("\n\n");
  const written = await writePosts(apiKey, { task, image: await thumbnail(db, env, img.driveFileId, now) });
  const suggestions = [...img.suggestions, ...fresh(written, known)].slice(0, MAX_SUGGESTIONS);
  const [updated] = await db.update(images).set({ suggestions, suggestedAt: now, updatedAt: now }).where(eq(images.id, imageId)).returning();
  return updated!;
}

/** AI viết 4 bài chữ hỏi fan (vào kho dạng bài chữ, chờ duyệt). Trả về số bài mới. */
export async function suggestFanPosts(db: Db, env: WorkerEnv, now: number) {
  const apiKey = requireKey(env);
  const [active, recent, existing] = await Promise.all([
    db.select({ name: topics.name, brief: topics.brief }).from(topics).where(eq(topics.enabled, true)),
    // Tên media vừa đăng: để câu hỏi bám theo những gì fan vừa xem.
    db
      .selectDistinct({ name: images.name })
      .from(images)
      .innerJoin(posts, eq(posts.imageKey, images.driveFileId))
      .where(and(inArray(images.kind, ["image", "reel"]), gt(posts.scheduledAt, now - 14 * DAY_MS), lt(posts.scheduledAt, now)))
      .orderBy(desc(posts.scheduledAt))
      .limit(15),
    db.select({ captions: images.captions, suggestions: images.suggestions }).from(images).where(eq(images.kind, "text")),
  ]);
  const known = existing.flatMap((e) => [...e.captions, ...e.suggestions]);
  const task = [
    `Topics this page covers:\n${active.map((t) => `- ${t.name}: ${t.brief}`).join("\n") || "- unexplained mysteries"}`,
    recent.length ? `Recently posted (file names, often the working titles):\n${recent.map((r) => `- ${r.name}`).join("\n")}` : "",
    known.length ? `Existing text posts, do not repeat or paraphrase them:\n${known.slice(-30).map((c) => `- ${c}`).join("\n")}` : "",
    `Write ${FAN_POSTS_PER_CALL} short text-only posts (1-3 sentences, no hashtags) that ask the audience a question to start a discussion in the comments, for example which mystery the page should dig into next, or which theory they think is closest to the truth.`,
  ].filter(Boolean).join("\n\n");
  const written = fresh(await writePosts(apiKey, { task }), known);
  for (const text of written) {
    await db.insert(images).values({
      driveFileId: `text-${crypto.randomUUID()}`,
      name: text.slice(0, 80),
      kind: "text",
      suggestions: [text],
      suggestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  return written.length;
}

/**
 * Chạy mỗi giờ (cron): gợi ý caption cho tối đa 3 media đang bật chưa có gợi ý chờ duyệt (ưu tiên media ít caption),
 * và viết thêm bài hỏi fan khi có Page dùng giờ bài chữ mà kho sắp hết. Không có ANTHROPIC_API_KEY thì bỏ qua.
 */
export async function autoSuggest(db: Db, env: WorkerEnv, now: number) {
  if (!env.ANTHROPIC_API_KEY) return { captions: 0, fanPosts: 0 };
  const due = await db
    .select({ id: images.id })
    .from(images)
    .where(
      and(
        eq(images.enabled, true),
        inArray(images.kind, ["image", "reel"]),
        sql`json_array_length(${images.suggestions}) = 0`,
        sql`json_array_length(${images.captions}) < ${MAX_SUGGESTIONS}`,
        or(isNull(images.suggestedAt), lt(images.suggestedAt, now - RESUGGEST_AFTER_MS)),
      ),
    )
    .orderBy(sql`json_array_length(${images.captions})`, desc(images.createdAt))
    .limit(AUTO_MEDIA_PER_RUN);
  let captions = 0;
  for (const { id } of due) {
    try {
      await suggestCaptions(db, env, id, now);
      captions++;
    } catch (err) {
      log("warn", "ai_suggest_failed", { imageId: id, message: (err as Error).message });
      // Lỗi key/giới hạn: các media sau cũng sẽ lỗi, dừng lượt này.
      if (err instanceof PublishFailure && err.kind !== "permanent") break;
    }
  }

  let fanPosts = 0;
  const usesText = await db.select({ id: pageTimes.id }).from(pageTimes).where(eq(pageTimes.kind, "text")).limit(1);
  if (usesText.length) {
    const textItems = await db
      .select({ captions: images.captions, suggestions: images.suggestions, suggestedAt: images.suggestedAt })
      .from(images)
      .where(
        and(
          eq(images.kind, "text"),
          eq(images.enabled, true),
          notInArray(images.driveFileId, db.select({ key: posts.imageKey }).from(posts).where(isNotNull(posts.imageKey))),
        ),
      );
    const ready = textItems.filter((t) => t.captions.length > 0).length;
    const pending = textItems.some((t) => t.suggestions.length > 0);
    const recentlyAsked = textItems.some((t) => (t.suggestedAt ?? 0) > now - DAY_MS);
    if (ready < MIN_READY_FAN_POSTS && !pending && !recentlyAsked) {
      fanPosts = await suggestFanPosts(db, env, now).catch((err: Error) => (log("warn", "ai_fan_posts_failed", { message: err.message }), 0));
    }
  }
  if (captions || fanPosts) log("info", "ai_suggest_done", { captions, fanPosts });
  return { captions, fanPosts };
}
