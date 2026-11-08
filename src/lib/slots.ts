import { DEFAULT_TZ, localDate, zonedToUtc } from "./time";

export type Slot = { weekday: number; minuteOfDay: number };

/**
 * Các thời điểm (epoch ms UTC) của slot lặp lại, sau `from`, trong `days` ngày tới, tăng dần.
 * `weekday` và giờ của slot tính theo múi giờ `tz`: 0 = Chủ nhật … 6 = Thứ bảy. Đúng cả khi đổi giờ mùa hè.
 */
export function upcomingSlotTimes(slots: Slot[], from: number, days = 28, tz: string = DEFAULT_TZ): number[] {
  const today = localDate(from, tz);
  const times: number[] = [];
  for (let i = 0; i <= days; i++) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const [y, m, d, weekday] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()];
    for (const s of slots) {
      if (s.weekday !== weekday) continue;
      const t = zonedToUtc(y, m, d, Math.floor(s.minuteOfDay / 60), s.minuteOfDay % 60, tz);
      if (t > from) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}
