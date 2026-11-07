import { DAY_MS, TZ_OFFSET_MS } from "./time";

export type Slot = { weekday: number; minuteOfDay: number };

/**
 * Các thời điểm (epoch ms UTC) của slot lặp lại, sau `from`, trong `days` ngày tới, tăng dần.
 * `weekday` theo giờ Bangkok: 0 = Chủ nhật … 6 = Thứ bảy.
 */
export function upcomingSlotTimes(slots: Slot[], from: number, days = 28): number[] {
  const todayStart = Math.floor((from + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
  const times: number[] = [];
  for (let d = 0; d <= days; d++) {
    const dayStart = todayStart + d * DAY_MS;
    const weekday = new Date(dayStart + TZ_OFFSET_MS).getUTCDay();
    for (const s of slots) {
      const t = dayStart + s.minuteOfDay * 60_000;
      if (s.weekday === weekday && t > from) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}
