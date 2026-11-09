import { beforeEach, describe, expect, it } from "vitest";
import sample from "../web/public/import-mau.csv?raw";
import { parseCsv } from "../src/lib/csv";
import { api, seed } from "./helpers";

beforeEach(seed);

describe("app settings", () => {
  it("defaults to Bangkok, then remembers the chosen time zone for every session", async () => {
    expect(await (await api("/settings")).json()).toEqual({ timeZone: "Asia/Bangkok" });
    expect((await api("/settings", { method: "PUT", json: { timeZone: "Europe/London" } })).status).toBe(200);
    expect(await (await api("/settings")).json()).toEqual({ timeZone: "Europe/London" });
    await api("/settings", { method: "PUT", json: { timeZone: "America/New_York" } });
    expect(await (await api("/settings")).json()).toEqual({ timeZone: "America/New_York" });
  });

  it("rejects an unsupported time zone", async () => {
    expect((await api("/settings", { method: "PUT", json: { timeZone: "Mars/Base" } })).status).toBe(400);
  });
});

describe("sample CSV", () => {
  it("imports cleanly once its Page names match real Pages", () => {
    const pages = [
      { id: 1, name: "Tên Page của bạn", externalId: "111" },
      { id: 2, name: "Tên Page A", externalId: "222" },
      { id: 3, name: "Tên Page B", externalId: "333" },
      { id: 4, name: "Page theo ID", externalId: "123456789012345" },
    ];
    const result = parseCsv(sample, { pages }, Date.parse("2026-11-09T00:00:00Z"), "Asia/Bangkok");
    expect("posts" in result && result.posts.map((p) => p.targets.map((t) => t.accountId))).toEqual([[1], [1], [2, 3], [4]]);
    expect("posts" in result && result.posts[0]!.caption).toContain("\n");
  });
});
