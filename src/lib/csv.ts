import Papa from "papaparse";
import { z } from "zod";
import { contentError, type Destinations, type Platform, type PostInput, type TargetInput } from "./posts";
import { parseScheduleTime } from "./time";

export const CSV_COLUMNS = ["caption", "link", "image_url", "platforms", "scheduled_at", "board"] as const;
export const CSV_MAX_ROWS = 200;
export type LineError = { line: number; message: string };

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const rowSchema = z.object({
  caption: z.string().trim().min(1, "caption trống"),
  link: optional(z.url({ protocol: /^https?$/, error: "link không phải URL http(s)" })),
  image_url: optional(z.url({ protocol: /^https$/, error: "image_url phải là URL https" })),
  platforms: z.string(),
  scheduled_at: optional(z.string()),
  board: optional(z.string().trim()),
});
type Row = z.infer<typeof rowSchema>;

function parsePlatforms(value: string): Platform[] | string {
  const parts = value.toLowerCase().split(/[|,;\s]+/).filter(Boolean);
  const bad = parts.filter((p) => p !== "facebook" && p !== "pinterest");
  if (parts.length === 0) return "platforms trống";
  if (bad.length) return `platforms không hợp lệ: ${bad.join(", ")}`;
  return [...new Set(parts)] as Platform[];
}

function rowTargets(platforms: Platform[], row: Row, dest: Destinations): TargetInput[] | string {
  const targets: TargetInput[] = [];
  if (platforms.includes("facebook")) {
    // CSV không có cột Page: dùng Page duy nhất đang bật (PLAN.md mục 6).
    if (dest.pages.length !== 1) return `cần đúng 1 Page Facebook đang bật, hiện có ${dest.pages.length}`;
    targets.push({ platform: "facebook", accountId: dest.pages[0]!.id, boardId: null });
  }
  if (platforms.includes("pinterest")) {
    if (!row.board) return "Pinterest cần cột board";
    const wanted = row.board.toLowerCase();
    const board = dest.boards.find((b) => b.name.toLowerCase() === wanted || b.externalId === row.board);
    if (!board) return `không có board đang bật tên/id "${row.board}"`;
    targets.push({ platform: "pinterest", accountId: board.accountId, boardId: board.id });
  }
  return targets;
}

function rowToPost(raw: unknown, dest: Destinations, now: number): PostInput | string {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  const row = parsed.data;
  const platforms = parsePlatforms(row.platforms);
  if (typeof platforms === "string") return platforms;
  const targets = rowTargets(platforms, row, dest);
  if (typeof targets === "string") return targets;
  const scheduledAt = row.scheduled_at ? parseScheduleTime(row.scheduled_at) : null;
  if (row.scheduled_at && scheduledAt === null) return `scheduled_at không phải ISO 8601: "${row.scheduled_at}"`;
  if (scheduledAt !== null && scheduledAt <= now) return "scheduled_at đã qua";
  const post = { caption: row.caption, link: row.link ?? null, imageKey: null, imageUrl: row.image_url ?? null, scheduledAt, targets };
  return contentError(post) ?? post;
}

/**
 * Parse và validate toàn bộ file. Có lỗi ở bất kỳ dòng nào thì chỉ trả lỗi, không trả bài nào.
 * `line` là số thứ tự bản ghi tính cả header là dòng 1 (một caption nhiều dòng vẫn tính là một).
 */
export function parseCsv(text: string, dest: Destinations, now: number): { posts: PostInput[] } | { errors: LineError[] } {
  const result = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const missing = CSV_COLUMNS.filter((c) => !result.meta.fields?.includes(c));
  if (missing.length) return { errors: [{ line: 1, message: `thiếu cột: ${missing.join(", ")}` }] };
  if (result.data.length === 0) return { errors: [{ line: 1, message: "file không có dòng dữ liệu" }] };
  if (result.data.length > CSV_MAX_ROWS) return { errors: [{ line: 1, message: `tối đa ${CSV_MAX_ROWS} dòng mỗi file` }] };

  const errors: LineError[] = result.errors.map((e) => ({ line: (e.row ?? 0) + 2, message: e.message }));
  const posts: PostInput[] = [];
  result.data.forEach((raw, i) => {
    const post = rowToPost(raw, dest, now);
    if (typeof post === "string") errors.push({ line: i + 2, message: post });
    else posts.push(post);
  });
  return errors.length ? { errors: errors.sort((a, b) => a.line - b.line) } : { posts };
}
