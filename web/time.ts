import { createContext, useContext } from "react";
import { DEFAULT_TZ, isTimeZone, localDate, parseScheduleTime, startOfLocalDay, type TimeZone } from "../src/lib/time";

export { startOfLocalDay, TIME_ZONES, type TimeZone } from "../src/lib/time";

/** Múi giờ đang chọn trên giao diện: mọi giờ hiển thị và giờ nhập vào đều theo múi giờ này. */
export const TzContext = createContext<TimeZone>(DEFAULT_TZ);
export const useTz = () => useContext(TzContext);

const STORAGE_KEY = "post-fb.tz";
export function loadTz(): TimeZone {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTimeZone(v) ? v : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}
export function saveTz(tz: TimeZone) {
  try {
    localStorage.setItem(STORAGE_KEY, tz);
  } catch {
    // không lưu được (chế độ riêng tư): vẫn dùng múi giờ cho phiên hiện tại
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function format(ms: number, tz: string, kind: "time" | "day" | "hour") {
  const key = `${tz}|${kind}`;
  let f = formatters.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === "time" ? { dateStyle: "short", timeStyle: "short" }
      : kind === "day" ? { weekday: "short", day: "2-digit", month: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
    f = new Intl.DateTimeFormat("vi-VN", { ...opts, timeZone: tz });
    formatters.set(key, f);
  }
  return f.format(ms);
}
export const formatTime = (ms: number, tz: TimeZone) => format(ms, tz, "time");
export const formatDay = (ms: number, tz: TimeZone) => format(ms, tz, "day");
export const formatHour = (ms: number, tz: TimeZone) => format(ms, tz, "hour");

export const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** 00:00 thứ hai (theo `tz`) của tuần chứa `ms`. */
export function weekStart(ms: number, tz: TimeZone): number {
  return startOfLocalDay(ms, tz, -((localDate(ms, tz).weekday + 6) % 7));
}

/** Giá trị ô datetime-local (giờ địa phương tại `tz`) → ISO UTC để gửi server. */
export function localInputToIso(value: string, tz: TimeZone): string | null {
  const ms = parseScheduleTime(value, tz);
  return ms === null ? null : new Date(ms).toISOString();
}
