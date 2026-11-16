// Lập lịch đăng tự động: chọn ảnh + caption cho từng khung giờ của từng Page. Logic thuần (không DB) để dễ test.
import { DAY_MS, localDate, zonedToUtc } from "./time";

/** Lên lịch trước bao nhiêu ngày. */
export const PLAN_DAYS = 7;
/** Không lập lịch khung giờ quá sát: chừa thời gian để xem lại và sửa bài. */
export const PLAN_LEAD_MS = 15 * 60_000;
/** Một ảnh không lặp lại trên cùng Page trong 7 ngày. */
export const SAME_PAGE_GAP_MS = 7 * DAY_MS;
/** Một ảnh không xuất hiện trên 2 Page trong cùng 24 giờ (tránh nội dung trùng lặp hàng loạt). */
export const ANY_PAGE_GAP_MS = DAY_MS;
/** Chọn ngẫu nhiên trong 5 ảnh lâu chưa dùng nhất: vừa ngẫu nhiên vừa xoay vòng đều kho ảnh. */
const PICK_FROM_OLDEST = 5;

/** Chủ đề có ít hơn bấy nhiêu bài đã đo thì chưa đủ dữ liệu: giữ trọng số 1 để vẫn được thử. */
export const MIN_SAMPLES = 3;
/** Chủ đề kém nhất vẫn giữ 1/4 trọng số, để còn đo tiếp thay vì biến mất hẳn. */
export const MIN_WEIGHT = 0.25;
/** Mọi ngày trong tuần (bitmask, bit 0 = Chủ nhật). */
export const EVERY_DAY = 127;

export type MediaKind = "image" | "reel" | "text";
export type PageTime = { accountId: number; minuteOfDay: number; kind?: MediaKind; days?: number; topicId?: number | null };
/** topicId null/thiếu: app tự chọn chủ đề theo trọng số. */
export type PlanSlot = { accountId: number; at: number; kind?: MediaKind; topicId?: number | null };
export type PlanImage = { driveFileId: string; captions: string[]; kind?: MediaKind; folderId?: string | null; topicId?: number | null };
/** Một lần media đã/sẽ đăng. `caption` để chặn đăng lại cùng caption trên cùng Page. */
export type ImageUse = { imageKey: string; accountId: number; at: number; caption?: string };
export type PlannedPost = PlanSlot & { imageKey: string; caption: string; topicId: number | null };
/** Trọng số chọn chủ đề cho một Page (lớn hơn = hay được chọn hơn). */
export type TopicWeight = (accountId: number, topicId: number | null) => number;

/** Khoá idempotency của bài tự động: mỗi Page × mỗi khung giờ chỉ có một bài, kể cả khi bộ lập lịch chạy trùng. */
export const autoKey = (s: PlanSlot) => `auto:${s.accountId}:${s.at}`;

/** Mọi khung giờ (UTC ms) trong `days` ngày tới của các Page, theo giờ địa phương tại `tz`, tăng dần. */
export function upcomingPageSlots(times: PageTime[], now: number, tz: string, days = PLAN_DAYS): PlanSlot[] {
  const today = localDate(now, tz);
  const slots: PlanSlot[] = [];
  for (let d = 0; d <= days; d++) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + d));
    for (const t of times) {
      if (((t.days ?? EVERY_DAY) & (1 << date.getUTCDay())) === 0) continue;
      const at = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(t.minuteOfDay / 60), t.minuteOfDay % 60, tz);
      if (at > now + PLAN_LEAD_MS && at <= now + days * DAY_MS) slots.push({ accountId: t.accountId, at, kind: t.kind ?? "image", topicId: t.topicId ?? null });
    }
  }
  return slots.sort((a, b) => a.at - b.at || a.accountId - b.accountId);
}

const tooClose = (use: ImageUse, slot: PlanSlot) => {
  const gap = Math.abs(use.at - slot.at);
  return gap < ANY_PAGE_GAP_MS || (use.accountId === slot.accountId && gap < SAME_PAGE_GAP_MS);
};

export const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Trọng số chủ đề của từng Page từ lượt xem đã đo: trung vị lượt xem của chủ đề / trung vị của cả Page,
 * tối thiểu MIN_WEIGHT. Chủ đề chưa đủ MIN_SAMPLES bài đo (hoặc bài không có chủ đề) giữ trọng số 1.
 * shortcut: chỉ dựa trên lượt xem; muốn ưu tiên lượt theo dõi thì đổi điểm sang follows/1.000 lượt xem.
 */
export function topicWeights(stats: { accountId: number; topicId: number | null; views: number }[]): TopicWeight {
  const byPage = new Map<number, typeof stats>();
  for (const s of stats) byPage.set(s.accountId, [...(byPage.get(s.accountId) ?? []), s]);
  const weights = new Map<string, number>();
  for (const [accountId, rows] of byPage) {
    const overall = median(rows.map((r) => r.views));
    const byTopic = new Map<number, number[]>();
    for (const r of rows) if (r.topicId !== null) byTopic.set(r.topicId, [...(byTopic.get(r.topicId) ?? []), r.views]);
    for (const [topicId, views] of byTopic) {
      if (views.length >= MIN_SAMPLES && overall > 0) weights.set(`${accountId}:${topicId}`, Math.max(MIN_WEIGHT, median(views) / overall));
    }
  }
  return (accountId, topicId) => (topicId === null ? 1 : (weights.get(`${accountId}:${topicId}`) ?? 1));
}

function weightedPick<T>(items: T[], weight: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, i) => sum + weight(i), 0);
  let r = random() * total;
  for (const item of items) {
    r -= weight(item);
    if (r < 0) return item;
  }
  return items.at(-1)!;
}

const captionKey = (imageKey: string, accountId: number, caption: string) => `${imageKey}\n${accountId}\n${caption}`;

/**
 * Chọn media + caption cho từng khung giờ theo thứ tự thời gian. `uses` là các lần media đã/sẽ đăng (kể cả bài thủ công).
 * - Khung giờ có chủ đề cố định chỉ lấy media của chủ đề đó; không cố định thì chọn chủ đề theo `weight`
 *   (trong các chủ đề còn media dùng được), rồi chọn media trong chủ đề đó.
 * - Không đăng lại cùng một caption của cùng media trên cùng Page (chặn đăng trùng); media hết caption mới cho Page đó thì bị bỏ qua.
 * - Không có media hợp lệ thì khung giờ vào `shortages`: thà bỏ trống còn hơn đăng lặp.
 * `fits`: media nào dùng được cho khung giờ nào (ảnh cho giờ ảnh, video trong thư mục của Page cho giờ Reels, bài chữ cho giờ bài chữ).
 */
export function planPosts(
  slots: PlanSlot[],
  images: PlanImage[],
  uses: ImageUse[],
  random = Math.random,
  fits: (img: PlanImage, slot: PlanSlot) => boolean = () => true,
  weight: TopicWeight = () => 1,
) {
  const usesByImage = new Map<string, ImageUse[]>();
  const usedCaptions = new Set<string>();
  const record = (u: ImageUse) => {
    usesByImage.set(u.imageKey, [...(usesByImage.get(u.imageKey) ?? []), u]);
    if (u.caption !== undefined) usedCaptions.add(captionKey(u.imageKey, u.accountId, u.caption));
  };
  uses.forEach(record);
  const lastUse = (key: string) => Math.max(-Infinity, ...(usesByImage.get(key) ?? []).map((u) => u.at));
  const freshCaptions = (img: PlanImage, accountId: number) => img.captions.filter((c) => !usedCaptions.has(captionKey(img.driveFileId, accountId, c)));
  const planned: PlannedPost[] = [];
  const shortages: PlanSlot[] = [];

  for (const slot of slots) {
    const fixedTopic = slot.topicId ?? null;
    let candidates = images.filter(
      (img) =>
        fits(img, slot) &&
        (fixedTopic === null || img.topicId === fixedTopic) &&
        freshCaptions(img, slot.accountId).length > 0 &&
        !(usesByImage.get(img.driveFileId) ?? []).some((u) => tooClose(u, slot)),
    );
    if (candidates.length === 0) {
      shortages.push(slot);
      continue;
    }
    if (fixedTopic === null) {
      const topic = weightedPick([...new Set(candidates.map((c) => c.topicId ?? null))], (t) => weight(slot.accountId, t), random);
      candidates = candidates.filter((c) => (c.topicId ?? null) === topic);
    }
    const oldest = candidates.sort((a, b) => lastUse(a.driveFileId) - lastUse(b.driveFileId)).slice(0, PICK_FROM_OLDEST);
    const image = oldest[Math.floor(random() * oldest.length)]!;
    const options = freshCaptions(image, slot.accountId);
    const caption = options[Math.floor(random() * options.length)]!;
    record({ imageKey: image.driveFileId, accountId: slot.accountId, at: slot.at, caption });
    planned.push({ ...slot, imageKey: image.driveFileId, caption, topicId: image.topicId ?? null });
  }
  return { planned, shortages };
}

/** Số ảnh tối thiểu (có caption) để lấp kín lịch: đủ cho mọi Page trong 1 ngày, và đủ 7 ngày cho Page đăng nhiều nhất. */
export function minImagesNeeded(timesPerPage: number[]): number {
  const perDay = timesPerPage.reduce((a, b) => a + b, 0);
  return Math.max(perDay, 7 * Math.max(0, ...timesPerPage));
}
