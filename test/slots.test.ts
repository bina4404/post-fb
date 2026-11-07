import { expect, it } from "vitest";
import { upcomingSlotTimes } from "../src/lib/slots";
import { parseScheduleTime } from "../src/lib/time";

it("converts Bangkok wall time to UTC", () => {
  expect(parseScheduleTime("2026-11-10 09:00")).toBe(Date.parse("2026-11-10T02:00:00Z"));
  expect(parseScheduleTime("2026-11-10T09:00:00Z")).toBe(Date.parse("2026-11-10T09:00:00Z"));
  expect(parseScheduleTime("10/11/2026")).toBeNull();
});

it("lists slot times in Bangkok weekdays, skipping times already past", () => {
  // Thứ ba 10/11/2026 lúc 08:00 Bangkok.
  const from = Date.parse("2026-11-10T08:00+07:00");
  const times = upcomingSlotTimes(
    [
      { weekday: 2, minuteOfDay: 7 * 60 }, // thứ ba 07:00: hôm nay đã qua
      { weekday: 2, minuteOfDay: 23 * 60 + 30 }, // thứ ba 23:30 Bangkok = 16:30 UTC cùng ngày
      { weekday: 3, minuteOfDay: 0 }, // thứ tư 00:00 Bangkok = 17:00 UTC thứ ba
    ],
    from,
    7,
  );
  expect(times.slice(0, 3).map((t) => new Date(t).toISOString())).toEqual([
    "2026-11-10T16:30:00.000Z",
    "2026-11-10T17:00:00.000Z",
    "2026-11-17T00:00:00.000Z", // thứ ba tuần sau 07:00 Bangkok
  ]);
});
