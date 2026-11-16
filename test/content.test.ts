// Phát triển nội dung tự động: chủ đề + lịch tuần, bài chữ, AI gợi ý caption (chờ duyệt), đo Insights.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoSuggest, suggestFanPosts } from "../src/jobs/ai-content";
import { collectInsights, MEASURE_AFTER_MS } from "../src/jobs/insights";
import { publishTarget } from "../src/jobs/publish";
import { encryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { api, DRIVE, seed, seedDrive } from "./helpers";

const GRAPH = "https://graph.facebook.com/v27.0";
const CLAUDE = "https://api.anthropic.com/v1/messages";
const aiEnv = { ...env, ANTHROPIC_API_KEY: "test-anthropic-key" } as typeof env;
const DAY = 24 * 3_600_000;

/** Phản hồi giả của Claude Messages API: structured output là JSON trong khối text. */
const claudeReply = (posts: string[]) =>
  Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify({ posts }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

async function addTopic(name: string) {
  const res = await api("/topics", { method: "POST", json: { name, brief: `${name} brief` } });
  return ((await res.json()) as { id: number }).id;
}
async function addImage(fileId: string, topicId: number | null, captions: string[], kind = "image") {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO images (drive_file_id, name, kind, captions, topic_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(fileId, `${fileId}.jpg`, kind, JSON.stringify(captions), topicId, now, now)
    .run();
  return (await env.DB.prepare("SELECT id FROM images WHERE drive_file_id = ?").bind(fileId).first<{ id: number }>())!.id;
}
const autoPosts = async () =>
  (
    await env.DB.prepare(
      "SELECT p.id, p.kind, p.image_key, p.caption, p.topic_id, p.scheduled_at FROM posts p JOIN post_targets t ON t.post_id = p.id WHERE t.idempotency_key LIKE 'auto:%' ORDER BY p.scheduled_at",
    ).all<{ id: number; kind: string; image_key: string; caption: string; topic_id: number | null; scheduled_at: number }>()
  ).results;

beforeEach(async () => {
  await seed();
  await env.DB.prepare("UPDATE accounts SET access_token_enc = ?, enabled = 1").bind(await encryptToken("PAGE-TOKEN", env.TOKEN_ENC_KEY)).run();
});
afterEach(() => vi.restoreAllMocks());

describe("topics and weekly schedule", () => {
  it("schedules each weekly slot only on its days, with media of the slot's topic", async () => {
    const ufo = await addTopic("UFO");
    const relic = await addTopic("Cổ vật");
    for (let i = 0; i < 3; i++) await addImage(`ufo-image-${i}`, ufo, ["UFO caption"]);
    for (let i = 0; i < 3; i++) await addImage(`relic-img-${i}`, relic, ["Relic caption"]);
    const saturday = 1 << 6;
    const res = await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, slots: [{ minuteOfDay: 12 * 60, kind: "image", days: saturday, topicId: relic }] } });
    expect(res.status).toBe(200);
    const rows = await autoPosts();
    expect(rows.length).toBe(1); // một thứ Bảy trong 7 ngày tới
    expect(rows[0]).toMatchObject({ kind: "image", topic_id: relic, caption: "Relic caption" });

    const overview = (await (await api("/auto")).json()) as { pages: { id: number; slots: unknown[]; times: number[] }[] };
    expect(overview.pages.find((p) => p.id === 1)).toMatchObject({ slots: [{ minuteOfDay: 720, kind: "image", days: saturday, topicId: relic }], times: [720] });
  });

  it("rejects an unknown topic and drops media of a disabled topic from the schedule", async () => {
    const ufo = await addTopic("UFO");
    expect((await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, slots: [{ minuteOfDay: 600, kind: "image", topicId: 999 }] } })).status).toBe(400);
    for (let i = 0; i < 10; i++) await addImage(`ufo-image-${i}`, ufo, ["UFO caption"]);
    await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, times: [600] } });
    expect((await autoPosts()).length).toBeGreaterThan(0);
    await api(`/topics/${ufo}`, { method: "PATCH", json: { enabled: false } });
    expect(await autoPosts()).toEqual([]); // chỉ còn media của chủ đề đã tắt: gỡ hết, không lấp lại
  });
});

describe("text posts (ask the fans)", () => {
  it("fills text slots from approved text posts and publishes them to /feed without touching Drive", async () => {
    const res = await api("/images/text", { method: "POST", json: { text: "Which mystery next: Elvis, Tupac or Antarctica?" } });
    expect(res.status).toBe(201);
    await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, slots: [{ minuteOfDay: 18 * 60, kind: "text" }] } });
    const [post] = await autoPosts();
    expect(post).toMatchObject({ kind: "text", caption: "Which mystery next: Elvis, Tupac or Antarctica?" });
    expect((await autoPosts()).length).toBe(1); // một bài chữ chỉ đăng một lần trên mỗi Page

    const t = (await env.DB.prepare("SELECT id FROM post_targets WHERE post_id = ?").bind(post!.id).first<{ id: number }>())!;
    await env.DB.prepare("UPDATE post_targets SET next_attempt_at = ? WHERE id = ?").bind(Date.now() - 1000, t.id).run();
    const calls = mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ id: "page1_feed1" }) });
    expect(await publishTarget(env, t.id)).toBe("published");
    expect(calls).toHaveLength(1); // không gọi Drive
    expect(new URLSearchParams(new TextDecoder().decode(await calls[0]!.arrayBuffer())).get("message")).toBe("Which mystery next: Elvis, Tupac or Antarctica?");
  });
});

describe("AI suggestions", () => {
  it("adds 3 suggested captions that only reach the schedule after approval", async () => {
    await seedDrive();
    const topic = await addTopic("Người nổi tiếng");
    const id = await addImage("drive-celeb-1", topic, []);
    const calls = mockFetch({
      // Không có thumbnailLink: Drive trả file gốc (mock khớp theo đường dẫn, bỏ query).
      [`GET ${DRIVE}/files/drive-celeb-1`]: (req) =>
        new URL(req.url).searchParams.get("alt") === "media"
          ? new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } })
          : Response.json({ mimeType: "image/jpeg" }),
      [`POST ${CLAUDE}`]: () => claudeReply(["Did Paul McCartney really die in 1966?", "  ", "What really happened to Avril?"]),
    });
    const res = await api(`/images/${id}/suggest`, { method: "POST" }, aiEnv);
    expect(res.status).toBe(200);
    const img = (await res.json()) as { captions: string[]; suggestions: string[] };
    expect(img).toMatchObject({ captions: [], suggestions: ["Did Paul McCartney really die in 1966?", "What really happened to Avril?"] });
    const sent = (await calls.find((c) => c.url === CLAUDE)!.json()) as { model: string; system: string; messages: { content: { type: string }[] }[] };
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.messages[0]!.content.map((b) => b.type)).toEqual(["image", "text"]); // AI nhìn thấy ảnh

    // Chưa duyệt: không có bài tự động nào dùng gợi ý.
    await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, times: [600] } });
    expect(await autoPosts()).toEqual([]);
    // Duyệt 1 gợi ý: chuyển sang captions.
    await api(`/images/${id}`, { method: "PATCH", json: { captions: ["Did Paul McCartney really die in 1966?"], suggestions: ["What really happened to Avril?"] } });
    expect((await autoPosts()).map((p) => p.caption)).toEqual(["Did Paul McCartney really die in 1966?"]);
  });

  it("explains instead of failing when no API key is configured, and the hourly run is a no-op", async () => {
    const id = await addImage("drive-celeb-1", null, []);
    const res = await api(`/images/${id}/suggest`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ANTHROPIC_API_KEY");
    const calls = mockFetch({});
    expect(await autoSuggest((await import("../src/db/client")).getDb(env), env, Date.now())).toEqual({ captions: 0, fanPosts: 0 });
    expect(calls).toHaveLength(0);
  });

  it("writes fan questions as pending text posts, and a refusal becomes a readable error", async () => {
    mockFetch({ [`POST ${CLAUDE}`]: () => claudeReply(["Which theory is closest to the truth?", "Elvis, Tupac or Antarctica next?"]) });
    const { getDb } = await import("../src/db/client");
    expect(await suggestFanPosts(getDb(aiEnv), aiEnv, Date.now())).toBe(2);
    const rows = (await env.DB.prepare("SELECT kind, captions, suggestions FROM images WHERE kind = 'text'").all<{ captions: string; suggestions: string }>()).results;
    expect(rows.map((r) => [JSON.parse(r.captions), JSON.parse(r.suggestions)])).toEqual([[[], ["Which theory is closest to the truth?"]], [[], ["Elvis, Tupac or Antarctica next?"]]]);

    vi.restoreAllMocks();
    mockFetch({ [`POST ${CLAUDE}`]: () => Response.json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } }) });
    const res = await api("/images/fan-posts", { method: "POST" }, aiEnv);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("từ chối");
  });
});

describe("insights", () => {
  async function publishedPost(kind: "image" | "reel", externalId: string, topicId: number | null, ageDays: number) {
    const at = Date.now() - ageDays * DAY;
    await env.DB.prepare("INSERT INTO posts (caption, kind, topic_id, scheduled_at, created_at, updated_at) VALUES ('c', ?, ?, ?, ?, ?)").bind(kind, topicId, at, at, at).run();
    const post = (await env.DB.prepare("SELECT max(id) AS id FROM posts").first<{ id: number }>())!;
    await env.DB.prepare("INSERT INTO post_targets (post_id, platform, account_id, status, idempotency_key, external_post_id, updated_at) VALUES (?, 'facebook', 1, 'published', ?, ?, ?)")
      .bind(post.id, `k-${externalId}`, externalId, at)
      .run();
    return post.id;
  }
  const stats = (externalId: string) => env.DB.prepare("SELECT views, follows, stats_at, updated_at FROM post_targets WHERE external_post_id = ?").bind(externalId).first<Record<string, number | null>>();

  it("measures posts 7 days after publishing, without changing updated_at, and feeds topic weights", async () => {
    const topic = await addTopic("UFO");
    await publishedPost("image", "page1_photo", topic, 8);
    await publishedPost("reel", "reel-video-1", topic, 9);
    await publishedPost("image", "page1_young", topic, 3); // chưa đủ 7 ngày
    const before = (await stats("page1_photo"))!.updated_at;
    mockFetch({
      [`GET ${GRAPH}/page1_photo/insights`]: (req) => {
        expect(new URL(req.url).searchParams.get("metric")).toBe("post_media_view");
        return Response.json({ data: [{ name: "post_media_view", period: "lifetime", values: [{ value: 25186 }] }] });
      },
      [`GET ${GRAPH}/reel-video-1/video_insights`]: () =>
        Response.json({ data: [{ name: "blue_reels_play_count", period: "lifetime", values: [{ value: 1302804 }] }, { name: "post_video_followers", period: "lifetime", values: [{ value: 2787 }] }] }),
    });
    const { getDb } = await import("../src/db/client");
    expect(await collectInsights(getDb(env), env, Date.now())).toEqual({ measured: 2, due: 2 });
    expect(await stats("page1_photo")).toMatchObject({ views: 25186, follows: null, updated_at: before });
    expect(await stats("reel-video-1")).toMatchObject({ views: 1302804, follows: 2787 });
    expect((await stats("page1_young"))!.stats_at).toBeNull();

    const overview = (await (await api("/auto")).json()) as { pages: { id: number; topicStats: { topicId: number; measured: number }[] }[] };
    expect(overview.pages.find((p) => p.id === 1)!.topicStats).toContainEqual(expect.objectContaining({ topicId: topic, measured: 2 }));
  });

  it("leaves a post unmeasured when Facebook returns no data (missing read_insights), and stops a Page after an error", async () => {
    await publishedPost("image", "page1_a", null, 8);
    await publishedPost("image", "page1_b", null, 8);
    const calls = mockFetch({
      [`GET ${GRAPH}/page1_a/insights`]: () => Response.json({ data: [] }),
      [`GET ${GRAPH}/page1_b/insights`]: () => Response.json({ error: { message: "(#4) limit", code: 4 } }, { status: 400 }),
    });
    const { getDb } = await import("../src/db/client");
    expect((await collectInsights(getDb(env), env, Date.now())).measured).toBe(0);
    expect((await stats("page1_a"))!.stats_at).toBeNull();
    expect(calls).toHaveLength(2);
    expect(MEASURE_AFTER_MS).toBe(7 * DAY);
  });
});
