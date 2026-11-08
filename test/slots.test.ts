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

it("converts London and Washington wall time with daylight saving", () => {
  expect(parseScheduleTime("2026-01-15 09:00", "Europe/London")).toBe(Date.parse("2026-01-15T09:00:00Z")); // GMT
  expect(parseScheduleTime("2026-07-15 09:00", "Europe/London")).toBe(Date.parse("2026-07-15T08:00:00Z")); // BST
  expect(parseScheduleTime("2026-01-15 09:00", "America/New_York")).toBe(Date.parse("2026-01-15T14:00:00Z")); // EST
  expect(parseScheduleTime("2026-07-04 09:00", "America/New_York")).toBe(Date.parse("2026-07-04T13:00:00Z")); // EDT
  // 02:30 ngày 08/03/2026 không tồn tại ở New York (đồng hồ nhảy 02:00 → 03:00): đẩy lên sau khoảng nhảy.
  expect(parseScheduleTime("2026-03-08 02:30", "America/New_York")).toBe(Date.parse("2026-03-08T07:30:00Z"));
  expect(parseScheduleTime("2026-02-30 09:00", "Europe/London")).toBeNull();
  expect(parseScheduleTime("2026-07-15T09:00:00+02:00", "America/New_York")).toBe(Date.parse("2026-07-15T07:00:00Z"));
});

it("keeps slots at the same London wall time across the clock change", () => {
  // Thứ hai 09:00 London: 23/03 còn GMT, 30/03 đã sang BST (29/03/2026).
  const from = Date.parse("2026-03-22T12:00:00Z");
  const times = upcomingSlotTimes([{ weekday: 1, minuteOfDay: 9 * 60 }], from, 9, "Europe/London");
  expect(times.map((t) => new Date(t).toISOString())).toEqual(["2026-03-23T09:00:00.000Z", "2026-03-30T08:00:00.000Z"]);
});

it("finds local day starts and week starts in the chosen zone", async () => {
  const { startOfLocalDay } = await import("../src/lib/time");
  const sun = Date.parse("2026-03-29T12:00:00Z"); // ngày đổi giờ ở London
  expect(new Date(startOfLocalDay(sun, "Europe/London")).toISOString()).toBe("2026-03-29T00:00:00.000Z");
  expect(new Date(startOfLocalDay(sun, "Europe/London", 1)).toISOString()).toBe("2026-03-29T23:00:00.000Z");
  expect(new Date(startOfLocalDay(sun, "America/New_York", -1)).toISOString()).toBe("2026-03-28T04:00:00.000Z");
});
