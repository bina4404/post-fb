import { describe, expect, it } from "vitest";
import { ANY_PAGE_GAP_MS, minImagesNeeded, planPosts, SAME_PAGE_GAP_MS, upcomingPageSlots, type PlanImage } from "../src/lib/autoplan";

const HOUR = 3_600_000;
const img = (id: string, captions = ["c1", "c2"]): PlanImage => ({ driveFileId: id, captions });
const fixed = () => 0; // luôn chọn phần tử đầu: ảnh lâu chưa dùng nhất, caption đầu

describe("upcomingPageSlots", () => {
  it("lists each Page's daily times for the next 7 days in the app time zone", () => {
    const now = Date.parse("2026-11-12T00:00:00Z"); // 07:00 Bangkok
    const slots = upcomingPageSlots([{ accountId: 1, minuteOfDay: 9 * 60 }, { accountId: 2, minuteOfDay: 20 * 60 }], now, "Asia/Bangkok");
    expect(slots).toHaveLength(14);
    expect(new Date(slots[0]!.at).toISOString()).toBe("2026-11-12T02:00:00.000Z"); // 09:00 Bangkok hôm nay
    expect(slots.every((s) => s.at > now && s.at <= now + 7 * 24 * HOUR)).toBe(true);
  });

  it("skips a time that is less than 15 minutes away", () => {
    const now = Date.parse("2026-11-12T01:50:00Z"); // 08:50 Bangkok
    const slots = upcomingPageSlots([{ accountId: 1, minuteOfDay: 9 * 60 }], now, "Asia/Bangkok", 2);
    expect(new Date(slots[0]!.at).toISOString()).toBe("2026-11-13T02:00:00.000Z");
  });
});

describe("planPosts", () => {
  const base = Date.parse("2026-11-12T00:00:00Z");

  it("never repeats an image on the same Page within 7 days", () => {
    const slots = Array.from({ length: 7 }, (_, d) => ({ accountId: 1, at: base + d * 24 * HOUR }));
    const { planned, shortages } = planPosts(slots, [img("a"), img("b"), img("c")], [], fixed);
    expect(planned.map((p) => p.imageKey)).toEqual(["a", "b", "c"]);
    expect(shortages).toHaveLength(4); // chỉ có 3 ảnh: thà bỏ trống còn hơn lặp
  });

  it("never puts the same image on two Pages within 24 hours", () => {
    const slots = [
      { accountId: 1, at: base },
      { accountId: 2, at: base + HOUR },
      { accountId: 2, at: base + ANY_PAGE_GAP_MS },
    ];
    const { planned } = planPosts(slots, [img("a"), img("b")], [], fixed);
    expect(planned.map((p) => [p.accountId, p.imageKey])).toEqual([[1, "a"], [2, "b"], [2, "a"]]);
  });

  it("respects existing uses, including manual posts, and prefers the least recently used image", () => {
    const uses = [
      { imageKey: "a", accountId: 1, at: base - SAME_PAGE_GAP_MS + HOUR }, // còn trong 7 ngày trên Page 1
      { imageKey: "b", accountId: 9, at: base - 3 * 24 * HOUR },
      { imageKey: "c", accountId: 9, at: base - 5 * 24 * HOUR },
    ];
    const { planned } = planPosts([{ accountId: 1, at: base }], [img("a"), img("b"), img("c")], uses, fixed);
    expect(planned[0]!.imageKey).toBe("c"); // a bị loại; c lâu chưa dùng hơn b
  });

  it("ignores images without captions and picks one of the image's captions", () => {
    const { planned, shortages } = planPosts([{ accountId: 1, at: base }], [img("empty", []), img("x", ["only"])], [], () => 0.99);
    expect(planned).toEqual([{ accountId: 1, at: base, imageKey: "x", caption: "only" }]);
    expect(shortages).toEqual([]);
  });
});

it("estimates how many images a schedule needs", () => {
  expect(minImagesNeeded([3, 3, 2])).toBe(21); // 7 ngày × 3 bài/ngày cho Page đăng nhiều nhất
  expect(minImagesNeeded(Array(11).fill(3))).toBe(33); // 11 Page × 3 bài trong cùng 24 giờ
  expect(minImagesNeeded([])).toBe(0);
});
