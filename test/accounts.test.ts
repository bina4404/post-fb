import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCsv } from "../src/lib/csv";
import { api, seed } from "./helpers";

beforeEach(seed);

describe("Pages with the same name", () => {
  it("shows the Facebook Page ID next to duplicate names", async () => {
    await env.DB.prepare("UPDATE accounts SET name = 'My Page', enabled = 1 WHERE platform = 'facebook'").run();
    const { accounts } = (await (await api("/accounts")).json()) as { accounts: { id: number; name: string }[] };
    expect(accounts.filter((a) => a.id !== 3).map((a) => a.name).sort()).toEqual(["My Page (ID page1)", "My Page (ID page2)"]);
  });

  it("CSV refuses an ambiguous Page name but accepts the Page id", () => {
    const dest = { pages: [{ id: 1, name: "My Page", externalId: "page1" }, { id: 2, name: "my page", externalId: "page2" }] };
    const csv = (pages: string) => `caption,link,image_url,scheduled_at,pages\nhi,,,,${pages}\n`;
    expect(JSON.stringify(parseCsv(csv("My Page"), dest, Date.now()))).toContain("cùng tên");
    expect(parseCsv(csv("page2"), dest, Date.now())).toMatchObject({ posts: [{ targets: [{ accountId: 2 }] }] });
  });
});
