import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCsv } from "../src/lib/csv";
import { api, count, inHours, seed } from "./helpers";

const header = "caption,link,image_url,scheduled_at";
const dest = { pages: [{ id: 1, name: "My Page", externalId: "page1" }] };
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

  it("needs at least one enabled Page, and a pages column when several are enabled", () => {
    const csv = [header, "x,,,"].join("\n");
    expect(parseCsv(csv, { pages: [] }, Date.now())).toEqual({ errors: [{ line: 1, message: "chưa bật Page Facebook nào (tab Tài khoản)" }] });
    const two = { pages: [{ id: 1, name: "A", externalId: "111" }, { id: 2, name: "B", externalId: "222" }] };
    expect(parseCsv(csv, two, Date.now())).toMatchObject({ errors: [{ line: 2 }] });
  });

  it("sends a row to the Pages named in the pages column, by name or Facebook id", () => {
    const three = { pages: [{ id: 1, name: "Shop A", externalId: "111" }, { id: 2, name: "Shop B", externalId: "222" }, { id: 3, name: "Shop C", externalId: "333" }] };
    const csv = [header + ",pages", "one,,,,shop a", "two,,,,111 | 222 | Shop A", "bad,,,,Nope"].join("\n");
    const result = parseCsv(csv, three, Date.now());
    expect(result).toEqual({ errors: [{ line: 4, message: 'không có Page đang bật tên/id "Nope"' }] });
    const ok = parseCsv([header + ",pages", "one,,,,shop a", "two,,,,111 | 222 | Shop A"].join("\n"), three, Date.now());
    expect("posts" in ok && ok.posts.map((p) => p.targets.map((t) => t.accountId))).toEqual([[1], [1, 2]]);
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
    const list = ((await (await api("/posts")).json()) as { items: { targets: { status: string; idempotencyKey: string; postId: number }[] }[] }).items;
    for (const post of list) {
      expect(post.targets.map((t) => t.status)).toEqual(["scheduled"]);
      expect(post.targets[0]!.idempotencyKey).toBe(`${post.targets[0]!.postId}:facebook:1`);
    }
  });
});

describe("time zones in CSV", () => {
  it("reads scheduled_at without offset in the chosen zone", () => {
    const csv = ["caption,link,image_url,scheduled_at", "x,,,2099-07-01 09:00"].join("\n");
    const result = parseCsv(csv, { pages: [{ id: 1, name: "P", externalId: "p" }] }, Date.now(), "Europe/London");
    expect(result).toMatchObject({ posts: [{ scheduledAt: Date.parse("2099-07-01T08:00:00Z") }] });
  });

  it("rejects an unsupported zone on import", async () => {
    await seed();
    expect((await api("/import?tz=Mars/Base", { method: "POST", body: "caption,link,image_url,scheduled_at" })).status).toBe(400);
  });
});

describe("import with several enabled Pages", () => {
  it("imports rows to the Pages in the pages column", async () => {
    await seed();
    await env.DB.prepare("UPDATE accounts SET enabled = 1").run();
    const csv = ["caption,link,image_url,scheduled_at,pages", "hello,,,,My Page|page2"].join("\n");
    expect(await (await api("/import", { method: "POST", body: csv })).json()).toEqual({ imported: 1 });
    expect(await count("post_targets")).toBe(2);
  });
});
