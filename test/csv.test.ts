import { beforeEach, describe, expect, it } from "vitest";
import { parseCsv } from "../src/lib/csv";
import { api, count, inHours, seed } from "./helpers";

const header = "caption,link,image_url,platforms,scheduled_at,board";
const dest = {
  pages: [{ id: 1, name: "My Page" }],
  boards: [{ id: 10, accountId: 2, name: "Recipes", externalId: "b-ext-1" }],
};

describe("parseCsv", () => {
  it("parses quoted captions with commas, quotes and newlines", () => {
    const csv = `${header}\n"Hello, ""world""\nline 2",https://x.test,https://img.test/a.jpg,facebook|pinterest,2099-01-01 09:00,recipes\n`;
    const result = parseCsv(csv, dest, Date.now());
    expect(result).toEqual({
      posts: [
        {
          caption: 'Hello, "world"\nline 2',
          link: "https://x.test",
          imageKey: null,
          imageUrl: "https://img.test/a.jpg",
          scheduledAt: Date.parse("2099-01-01T09:00+07:00"),
          targets: [
            { platform: "facebook", accountId: 1, boardId: null },
            { platform: "pinterest", accountId: 2, boardId: 10 },
          ],
        },
      ],
    });
  });

  it("reports every bad row with its line number", () => {
    const csv = [
      header,
      "ok,,,facebook,,",
      ",,,facebook,,", // caption trống
      "pin,,,pinterest,,Recipes", // thiếu ảnh
      "x,,,twitter,,", // nền tảng lạ
      "x,,,facebook,2001-01-01T00:00Z,", // đã qua
      "x,,https://i.test/a.jpg,pinterest,,Nope", // board không có
    ].join("\n");
    const result = parseCsv(csv, dest, Date.now());
    expect("errors" in result && result.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
  });

  it("requires exactly one enabled Facebook Page", () => {
    const result = parseCsv(`${header}\nx,,,facebook,,`, { ...dest, pages: [] }, Date.now());
    expect(result).toEqual({ errors: [{ line: 2, message: "cần đúng 1 Page Facebook đang bật, hiện có 0" }] });
  });

  it("accepts the UTF-8 BOM that Excel writes", () => {
    expect(parseCsv(`\uFEFF${header}\nx,,,facebook,,`, dest, Date.now())).toHaveProperty("posts");
  });

  it("rejects a file with missing columns", () => {
    expect(parseCsv("caption,link\nx,", dest, Date.now())).toMatchObject({ errors: [{ line: 1 }] });
  });
});

describe("POST /api/import", () => {
  beforeEach(seed);

  it("imports nothing when one row is invalid", async () => {
    const csv = `${header}\ngood,,,facebook,${inHours(2)},\n,,,facebook,,\n`;
    const res = await api("/import", { method: "POST", body: csv });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: [{ line: 3, message: "caption: caption trống" }] });
    expect(await count("posts")).toBe(0);
  });

  it("imports all rows with their targets and schedule", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `post ${i},,https://i.test/${i}.jpg,facebook|pinterest,${inHours(i + 1)},b-ext-1`);
    const res = await api("/import", { method: "POST", body: [header, ...rows].join("\n") });
    expect(await res.json()).toEqual({ imported: 10 });
    expect(await count("posts")).toBe(10);
    expect(await count("post_targets")).toBe(20);
    const list = (await (await api("/posts")).json()) as { targets: { status: string; idempotencyKey: string; postId: number }[] }[];
    for (const post of list) {
      expect(post.targets.map((t) => t.status)).toEqual(["scheduled", "scheduled"]);
      expect(post.targets[0]!.idempotencyKey).toBe(`${post.targets[0]!.postId}:facebook:1:0`);
    }
  });
});
