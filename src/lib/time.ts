// Múi giờ cho lịch đăng. Dùng chung cho Worker và giao diện web (web import file này).
// Mọi thời điểm lưu trong DB là epoch ms UTC; múi giờ chỉ dùng để nhập và hiển thị giờ địa phương.

export const TIME_ZONES = [
  { id: "Asia/Bangkok", label: "Việt Nam / Bangkok (UTC+7)" },
  { id: "Europe/London", label: "London (GMT/BST)" },
  { id: "America/New_York", label: "Washington / New York (ET)" },
  { id: "America/Chicago", label: "Chicago (CT)" },
  { id: "America/Los_Angeles", label: "Los Angeles (PT)" },
  { id: "Australia/Sydney", label: "Sydney (AET)" },
  { id: "UTC", label: "UTC" },
] as const;
export type TimeZone = (typeof TIME_ZONES)[number]["id"];
export const DEFAULT_TZ: TimeZone = "Asia/Bangkok";
export const TIME_ZONE_IDS = TIME_ZONES.map((z) => z.id) as [TimeZone, ...TimeZone[]];
export const isTimeZone = (v: unknown): v is TimeZone => TIME_ZONE_IDS.includes(v as TimeZone);

export const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(ms: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, min: p.minute!, s: p.second! };
}

/** Độ lệch (ms) của múi giờ so với UTC tại thời điểm `ms` (có tính giờ mùa hè). */
function offsetMs(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Giờ địa phương (y-m-d h:min:s tại `tz`) → epoch ms UTC.
 * Giờ không tồn tại (đồng hồ nhảy lên khi vào giờ mùa hè) được đẩy lên sau khoảng nhảy.
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string, s = 0): number {
  const wall = Date.UTC(y, m - 1, d, h, min, s);
  const first = wall - offsetMs(wall, tz);
  const second = wall - offsetMs(first, tz);
  // second hiển thị đúng giờ yêu cầu thì dùng; không thì giờ đó rơi vào khoảng nhảy giờ mùa hè → lấy first (sau khoảng nhảy).
  return second + offsetMs(second, tz) === wall ? second : first;
}

/** Ngày địa phương tại `tz` của thời điểm `ms`; weekday 0 = Chủ nhật … 6 = Thứ bảy. */
export function localDate(ms: number, tz: string) {
  const w = wallClock(ms, tz);
  return { y: w.y, m: w.m, d: w.d, weekday: new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() };
}

/** 00:00 địa phương của ngày cách ngày chứa `ms` đúng `days` ngày (đúng cả khi đổi giờ mùa hè). */
export function startOfLocalDay(ms: number, tz: string, days = 0): number {
  const { y, m, d } = localDate(ms, tz);
  const target = new Date(Date.UTC(y, m - 1, d + days));
  return zonedToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), 0, 0, tz);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** ISO 8601 → epoch ms UTC. Không có offset thì hiểu là giờ địa phương tại `tz`. Ngày giờ không hợp lệ → null. */
export function parseScheduleTime(input: string, tz: string = DEFAULT_TZ): number | null {
  const value = input.trim().replace(" ", "T");
  const m = ISO.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null;
  if (m[7]) return Date.parse(value);
  return zonedToUtc(y, mo, d, h, mi, tz, s);
}
