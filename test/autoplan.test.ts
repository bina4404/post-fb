import { describe, expect, it } from "vitest";
import { ANY_PAGE_GAP_MS, MIN_WEIGHT, minImagesNeeded, planPosts, SAME_PAGE_GAP_MS, topicWeights, upcomingPageSlots, type PlanImage } from "../src/lib/autoplan";

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

  it("only uses the weekdays in the slot's day mask, and carries the slot's topic", () => {
    const now = Date.parse("2026-11-16T00:00:00Z"); // thứ Hai 07:00 Bangkok
    const monWedFri = (1 << 1) | (1 << 3) | (1 << 5);
    const slots = upcomingPageSlots([{ accountId: 1, minuteOfDay: 19 * 60, kind: "reel", days: monWedFri, topicId: 3 }], now, "Asia/Bangkok");
    expect(slots.map((s) => new Date(s.at).getUTCDay())).toEqual([1, 3, 5]); // 19:00 Bangkok cùng ngày UTC
    expect(slots.every((s) => s.kind === "reel" && s.topicId === 3)).toBe(true);
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
    expect(planned).toEqual([{ accountId: 1, at: base, imageKey: "x", caption: "only", topicId: null }]);
    expect(shortages).toEqual([]);
  });
});

it("estimates how many images a schedule needs", () => {
  expect(minImagesNeeded([3, 3, 2])).toBe(21); // 7 ngày × 3 bài/ngày cho Page đăng nhiều nhất
  expect(minImagesNeeded(Array(11).fill(3))).toBe(33); // 11 Page × 3 bài trong cùng 24 giờ
  expect(minImagesNeeded([])).toBe(0);
});

describe("topics and duplicate blocking", () => {
  const base = Date.parse("2026-11-12T00:00:00Z");
  const tagged = (id: string, topicId: number, captions = ["c1"]): PlanImage => ({ driveFileId: id, captions, topicId });

  it("a slot with a fixed topic only takes media of that topic", () => {
    const { planned, shortages } = planPosts([{ accountId: 1, at: base, topicId: 2 }, { accountId: 1, at: base + 8 * 24 * HOUR, topicId: 9 }], [tagged("a", 1), tagged("b", 2)], [], fixed);
    expect(planned.map((p) => [p.imageKey, p.topicId])).toEqual([["b", 2]]);
    expect(shortages).toHaveLength(1); // không có media chủ đề 9
  });

  it("a slot without a topic picks the topic by weight", () => {
    const images = [tagged("a", 1), tagged("b", 2)];
    const heavy2 = (_: number, t: number | null) => (t === 2 ? 9 : 1);
    // random 0.5 rơi vào phần của chủ đề 2 (9/10 tổng trọng số), dù ảnh "a" lâu chưa dùng hơn
    expect(planPosts([{ accountId: 1, at: base }], images, [], () => 0.5, undefined, heavy2).planned[0]!.imageKey).toBe("b");
    expect(planPosts([{ accountId: 1, at: base }], images, [], () => 0.05, undefined, heavy2).planned[0]!.imageKey).toBe("a");
  });

  it("never posts the same caption of the same media on the same Page again", () => {
    const old = base - 30 * 24 * HOUR; // ngoài 7 ngày: luật cũ cho phép đăng lại
    const uses = [{ imageKey: "a", accountId: 1, at: old, caption: "c1" }];
    const { planned } = planPosts([{ accountId: 1, at: base }, { accountId: 2, at: base + 2 * ANY_PAGE_GAP_MS }], [img("a", ["c1", "c2"])], uses, fixed);
    expect(planned.map((p) => [p.accountId, p.caption])).toEqual([[1, "c2"], [2, "c1"]]); // Page 2 chưa đăng c1
    const { shortages } = planPosts([{ accountId: 1, at: base }], [img("a", ["c1"])], uses, fixed);
    expect(shortages).toHaveLength(1); // hết caption mới cho Page 1
  });
});

describe("topicWeights", () => {
  const rows = (accountId: number, topicId: number | null, views: number[]) => views.map((v) => ({ accountId, topicId, views: v }));

  it("weights a topic by its median views relative to the Page, with a floor and a minimum sample", () => {
    const w = topicWeights([...rows(1, 1, [1000, 1200, 1100]), ...rows(1, 2, [100, 50, 80]), ...rows(1, 3, [5000, 6000]), ...rows(2, 1, [10, 10, 10])]);
    // Page 1: trung vị chung của 8 bài = (1000 + 1100) / 2 = 1050
    expect(w(1, 1)).toBeCloseTo(1100 / 1050);
    expect(w(1, 2)).toBe(MIN_WEIGHT); // 80/1050 thấp hơn mức sàn
    expect(w(1, 3)).toBe(1); // mới 2 bài: chưa đủ dữ liệu
    expect(w(1, 4)).toBe(1); // chưa có bài
    expect(w(1, null)).toBe(1);
    expect(w(2, 1)).toBe(1); // mỗi Page tính riêng
  });
});
