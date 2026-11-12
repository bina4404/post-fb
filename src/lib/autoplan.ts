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

export type PlanSlot = { accountId: number; at: number };
export type PlanImage = { driveFileId: string; captions: string[] };
export type ImageUse = { imageKey: string; accountId: number; at: number };
export type PlannedPost = PlanSlot & { imageKey: string; caption: string };

/** Khoá idempotency của bài tự động: mỗi Page × mỗi khung giờ chỉ có một bài, kể cả khi bộ lập lịch chạy trùng. */
export const autoKey = (s: PlanSlot) => `auto:${s.accountId}:${s.at}`;

/** Mọi khung giờ (UTC ms) trong `days` ngày tới của các Page, theo giờ địa phương tại `tz`, tăng dần. */
export function upcomingPageSlots(times: { accountId: number; minuteOfDay: number }[], now: number, tz: string, days = PLAN_DAYS): PlanSlot[] {
  const today = localDate(now, tz);
  const slots: PlanSlot[] = [];
  for (let d = 0; d <= days; d++) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + d));
    for (const t of times) {
      const at = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(t.minuteOfDay / 60), t.minuteOfDay % 60, tz);
      if (at > now + PLAN_LEAD_MS && at <= now + days * DAY_MS) slots.push({ accountId: t.accountId, at });
    }
  }
  return slots.sort((a, b) => a.at - b.at || a.accountId - b.accountId);
}

const tooClose = (use: ImageUse, slot: PlanSlot) => {
  const gap = Math.abs(use.at - slot.at);
  return gap < ANY_PAGE_GAP_MS || (use.accountId === slot.accountId && gap < SAME_PAGE_GAP_MS);
};

/**
 * Chọn ảnh cho từng khung giờ theo thứ tự thời gian. `uses` là các lần ảnh đã/sẽ đăng (kể cả bài thủ công).
 * Không có ảnh hợp lệ thì khung giờ đó vào `shortages`: thà bỏ trống còn hơn đăng lặp.
 */
export function planPosts(slots: PlanSlot[], images: PlanImage[], uses: ImageUse[], random = Math.random) {
  const usesByImage = new Map<string, ImageUse[]>();
  for (const u of uses) usesByImage.set(u.imageKey, [...(usesByImage.get(u.imageKey) ?? []), u]);
  const lastUse = (key: string) => Math.max(-Infinity, ...(usesByImage.get(key) ?? []).map((u) => u.at));
  const ready = images.filter((img) => img.captions.length > 0);
  const planned: PlannedPost[] = [];
  const shortages: PlanSlot[] = [];

  for (const slot of slots) {
    const candidates = ready.filter((img) => !(usesByImage.get(img.driveFileId) ?? []).some((u) => tooClose(u, slot)));
    if (candidates.length === 0) {
      shortages.push(slot);
      continue;
    }
    const oldest = candidates.sort((a, b) => lastUse(a.driveFileId) - lastUse(b.driveFileId)).slice(0, PICK_FROM_OLDEST);
    const image = oldest[Math.floor(random() * oldest.length)]!;
    const caption = image.captions[Math.floor(random() * image.captions.length)]!;
    const use = { imageKey: image.driveFileId, accountId: slot.accountId, at: slot.at };
    usesByImage.set(use.imageKey, [...(usesByImage.get(use.imageKey) ?? []), use]);
    planned.push({ ...slot, imageKey: image.driveFileId, caption });
  }
  return { planned, shortages };
}

/** Số ảnh tối thiểu (có caption) để lấp kín lịch: đủ cho mọi Page trong 1 ngày, và đủ 7 ngày cho Page đăng nhiều nhất. */
export function minImagesNeeded(timesPerPage: number[]): number {
  const perDay = timesPerPage.reduce((a, b) => a + b, 0);
  return Math.max(perDay, 7 * Math.max(0, ...timesPerPage));
}
