import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { api, seed } from "./helpers";

const GRAPH = "https://graph.facebook.com/v27.0";
const day = (name: string, values: number[]) => ({
  name,
  period: "day",
  values: values.map((value, i) => ({ value, end_time: `2026-11-0${i + 2}T08:00:00+0000` })),
});

beforeEach(async () => {
  await seed();
  const token = await encryptToken("PAGE-TOKEN", env.TOKEN_ENC_KEY);
  await env.DB.prepare("UPDATE accounts SET access_token_enc = ?, enabled = 1").bind(token).run();
});
afterEach(() => vi.restoreAllMocks());

describe("Page insights", () => {
  it("sums daily metrics per Page and reports a missing permission without breaking the table", async () => {
    const calls = mockFetch({
      [`GET ${GRAPH}/page1`]: () => Response.json({ followers_count: 1200 }),
      [`GET ${GRAPH}/page1/insights`]: () => Response.json({ data: [day("page_media_view", [10, 20]), day("page_post_engagements", [3, 4])] }),
      [`GET ${GRAPH}/page2`]: () => Response.json({ followers_count: 5 }),
      [`GET ${GRAPH}/page2/insights`]: () => Response.json({ error: { message: "(#10) Requires read_insights", code: 10 } }, { status: 403 }),
    });
    const res = await api("/insights?days=7");
    const body = (await res.json()) as { pages: { id: number; followers: number | null; totals: Record<string, number> | null; error: string | null }[] };
    const [p1, p2] = body.pages.sort((a, b) => a.id - b.id);
    expect(p1).toMatchObject({ followers: 1200, totals: { page_media_view: 30, page_post_engagements: 7, page_video_views: 0 }, error: null });
    expect(p2!.error).toContain("Kết nối Facebook");
    const insights = new URL(calls.find((c) => c.url.includes("page1/insights"))!.url);
    expect(Number(insights.searchParams.get("until")) - Number(insights.searchParams.get("since"))).toBe(7 * 86_400);
    expect(insights.searchParams.get("period")).toBe("day");
  });

  it("returns daily series dated to the counted day, plus posts with views and engagement", async () => {
    mockFetch({
      [`GET ${GRAPH}/page1`]: () => Response.json({ followers_count: 1200 }),
      [`GET ${GRAPH}/page1/insights`]: () => Response.json({ data: [day("page_media_view", [10, 20])] }),
      [`GET ${GRAPH}/page1/published_posts`]: () =>
        Response.json({
          data: [
            {
              id: "page1_1",
              message: "Hello",
              created_time: "2026-11-02T10:00:00+0000",
              shares: { count: 2 },
              reactions: { summary: { total_count: 9 } },
              comments: { summary: { total_count: 1 } },
              insights: { data: [{ name: "post_media_view", values: [{ value: 500 }] }] },
            },
          ],
        }),
    });
    const res = await api("/insights/1?days=28");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { daily: Record<string, { date: string; value: number }[]>; posts: unknown[] };
    expect(body.daily.page_media_view![0]).toEqual({ date: "2026-11-01", value: 10 });
    expect(body.posts[0]).toMatchObject({ id: "page1_1", views: 500, reactions: 9, comments: 1, shares: 2, clicks: 0 });
  });

  it("rejects an unsupported range", async () => {
    expect((await api("/insights?days=365")).status).toBe(400);
  });
});
