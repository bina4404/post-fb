import Papa from "papaparse";
import { z } from "zod";
import { contentError, type Destinations, type PostInput } from "./posts";
import { parseScheduleTime } from "./time";

// Cột bắt buộc. Cột "pages" là tuỳ chọn; cột thừa (ví dụ platforms, board của file cũ) được bỏ qua.
export const CSV_COLUMNS = ["caption", "link", "image_url", "scheduled_at"] as const;
export const CSV_MAX_ROWS = 200;
export type LineError = { line: number; message: string };

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const rowSchema = z.object({
  caption: z.string().trim().min(1, "caption trống"),
  link: optional(z.url({ protocol: /^https?$/, error: "link không phải URL http(s)" })),
  image_url: optional(z.url({ protocol: /^https$/, error: "image_url phải là URL https" })),
  scheduled_at: optional(z.string()),
  pages: optional(z.string()),
});

/**
 * Page đích của một dòng: cột "pages" liệt kê tên hoặc id Facebook của Page đang bật, ngăn cách bằng "|".
 * Bỏ trống thì dùng Page duy nhất đang bật; đang bật nhiều Page thì bắt buộc phải ghi.
 */
function rowPages(cell: string | undefined, dest: Destinations): number[] | string {
  if (!cell) {
    if (dest.pages.length === 1) return [dest.pages[0]!.id];
    return `cột pages trống mà đang bật ${dest.pages.length} Page: ghi tên hoặc id Page, ngăn cách bằng "|"`;
  }
  const ids: number[] = [];
  for (const wanted of cell.split("|").map((x) => x.trim()).filter(Boolean)) {
    const byId = dest.pages.find((p) => p.externalId === wanted);
    const byName = dest.pages.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
    if (!byId && byName.length > 1) return `có ${byName.length} Page cùng tên "${wanted}": ghi id Page thay cho tên`;
    const page = byId ?? byName[0];
    if (!page) return `không có Page đang bật tên/id "${wanted}"`;
    ids.push(page.id);
  }
  return ids.length ? [...new Set(ids)] : "cột pages không có Page nào";
}

function rowToPost(raw: unknown, dest: Destinations, now: number, tz?: string): PostInput | string {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  const row = parsed.data;
  const scheduledAt = row.scheduled_at ? parseScheduleTime(row.scheduled_at, tz) : null;
  if (row.scheduled_at && scheduledAt === null) return `scheduled_at không phải ISO 8601: "${row.scheduled_at}"`;
  if (scheduledAt !== null && scheduledAt <= now) return "scheduled_at đã qua";
  const pageIds = rowPages(row.pages, dest);
  if (typeof pageIds === "string") return pageIds;
  const targets = pageIds.map((accountId) => ({ platform: "facebook" as const, accountId }));
  const post = { caption: row.caption, link: row.link ?? null, imageKey: null, imageUrl: row.image_url ?? null, scheduledAt, targets };
  return contentError(post) ?? post;
}

/**
 * Parse và validate toàn bộ file. Có lỗi ở bất kỳ dòng nào thì chỉ trả lỗi, không trả bài nào.
 * `line` là số thứ tự bản ghi tính cả header là dòng 1 (một caption nhiều dòng vẫn tính là một).
 * `scheduled_at` không có offset được hiểu theo múi giờ `tz`.
 */
export function parseCsv(text: string, dest: Destinations, now: number, tz?: string): { posts: PostInput[] } | { errors: LineError[] } {
  const result = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const missing = CSV_COLUMNS.filter((c) => !result.meta.fields?.includes(c));
  if (missing.length) return { errors: [{ line: 1, message: `thiếu cột: ${missing.join(", ")}` }] };
  if (result.data.length === 0) return { errors: [{ line: 1, message: "file không có dòng dữ liệu" }] };
  if (result.data.length > CSV_MAX_ROWS) return { errors: [{ line: 1, message: `tối đa ${CSV_MAX_ROWS} dòng mỗi file` }] };
  if (dest.pages.length === 0) return { errors: [{ line: 1, message: "chưa bật Page Facebook nào (tab Tài khoản)" }] };

  const errors: LineError[] = result.errors.map((e) => ({ line: (e.row ?? 0) + 2, message: e.message }));
  const posts: PostInput[] = [];
  result.data.forEach((raw, i) => {
    const post = rowToPost(raw, dest, now, tz);
    if (typeof post === "string") errors.push({ line: i + 2, message: post });
    else posts.push(post);
  });
  return errors.length ? { errors: errors.sort((a, b) => a.line - b.line) } : { posts };
}
