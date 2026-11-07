const fmt = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Bangkok",
  dateStyle: "short",
  timeStyle: "short",
});

export const formatTime = (ms: number) => fmt.format(ms);

export const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

const BKK_OFFSET = 7 * 3_600_000;
export const DAY = 86_400_000;

/** Thời điểm (UTC ms) của 00:00 thứ hai, giờ Bangkok, của tuần chứa `ms`. */
export function weekStart(ms: number): number {
  const day = Math.floor((ms + BKK_OFFSET) / DAY);
  const mondayOffset = (day + 3) % 7; // 01/01/1970 là thứ năm
  return (day - mondayOffset) * DAY - BKK_OFFSET;
}

const dayFmt = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Bangkok", weekday: "short", day: "2-digit", month: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
export const formatDay = (ms: number) => dayFmt.format(ms);
export const formatHour = (ms: number) => hourFmt.format(ms);
