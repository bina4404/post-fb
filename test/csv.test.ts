import { beforeEach, describe, expect, it } from "vitest";
import { parseCsv } from "../src/lib/csv";
import { api, count, inHours, seed } from "./helpers";

const header = "caption,link,image_url,scheduled_at";
const dest = { pages: [{ id: 1, name: "My Page" }] };
const BOM = String.fromCharCode(0xfeff);

describe("parseCsv", () => {
  it("parses quoted captions with commas, quotes and newlines", () => {
    const csv = [header, '"Hello, ""world""', 'line 2",https://x.test,https://img.test/a.jpg,2099-01-01 09:00', ""].join("\n");
    expect(parseCsv(csv, dest, Date.now())).toEqual({
      posts: [
        {
          caption: ['Hello, "world"', "line 2"].join("\n"),
          link: "https://x.test",
          imageKey: null,
          imageUrl: "https://img.test/a.jpg",
          scheduledAt: Date.parse("2099-01-01T09:00+07:00"),
          targets: [{ platform: "facebook", accountId: 1 }],
        },
      ],
    });
  });

  it("reports every bad row with its line number", () => {
    const csv = [
      header,
      "ok,,,",
      ",https://x.test,,", // caption trống (dòng toàn ô trống bị bỏ qua như dòng rỗng)
      "x,ftp://x,,", // link không phải http(s)
      "x,,http://i.test/a.jpg,", // image_url không phải https
      "x,,,2001-01-01T00:00Z", // đã qua
      "x,,,10/11/2026", // không phải ISO
    ].join("\n");
    const result = parseCsv(csv, dest, Date.now());
    expect("errors" in result && result.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
  });

  it("requires exactly one enabled Facebook Page", () => {
    const csv = [header, "x,,,"].join("\n");
    expect(parseCsv(csv, { pages: [] }, Date.now())).toEqual({
      errors: [{ line: 1, message: "cần đúng 1 Page Facebook đang bật, hiện có 0" }],
    });
    const two = { pages: [{ id: 1, name: "A" }, { id: 2, name: "B" }] };
    expect(parseCsv(csv, two, Date.now())).toMatchObject({ errors: [{ line: 1 }] });
  });

  it("ignores old platforms/board columns and accepts the UTF-8 BOM", () => {
    const old = [BOM + "caption,link,image_url,platforms,scheduled_at,board", "x,,,facebook|pinterest,,Recipes"].join("\n");
    expect(parseCsv(old, dest, Date.now())).toHaveProperty("posts");
  });

  it("rejects a file with missing columns", () => {
    expect(parseCsv(["caption,link", "x,"].join("\n"), dest, Date.now())).toMatchObject({ errors: [{ line: 1 }] });
  });
});

describe("POST /api/import", () => {
  beforeEach(seed);

  it("imports nothing when one row is invalid", async () => {
    const csv = [header, `good,,,${inHours(2)}`, ",https://x.test,,", ""].join("\n");
    const res = await api("/import", { method: "POST", body: csv });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: [{ line: 3, message: "caption: caption trống" }] });
    expect(await count("posts")).toBe(0);
  });

  it("imports all rows to the enabled Page with their schedule", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `post ${i},,https://i.test/${i}.jpg,${inHours(i + 1)}`);
    const res = await api("/import", { method: "POST", body: [header, ...rows].join("\n") });
    expect(await res.json()).toEqual({ imported: 10 });
    expect(await count("posts")).toBe(10);
    expect(await count("post_targets")).toBe(10);
    const list = (await (await api("/posts")).json()) as { targets: { status: string; idempotencyKey: string; postId: number }[] }[];
    for (const post of list) {
      expect(post.targets.map((t) => t.status)).toEqual(["scheduled"]);
      expect(post.targets[0]!.idempotencyKey).toBe(`${post.targets[0]!.postId}:facebook:1`);
    }
  });
});
