import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, inHours, seed } from "./helpers";

type Post = { id: number; scheduledAt: number | null; targets: { status: string; nextAttemptAt: number | null }[] };

async function createPost(body: Record<string, unknown> = {}) {
  const res = await api("/posts", { method: "POST", json: { caption: "hi", facebookAccountId: 1, ...body } });
  expect(res.status).toBe(201);
  return (await res.json()) as Post;
}

beforeEach(seed);

describe("posts", () => {
  it("creates a draft with one target per destination", async () => {
    const post = await createPost({ pinterestBoardId: 10, imageUrl: "https://i.test/a.jpg" });
    expect(post.scheduledAt).toBeNull();
    expect(post.targets.map((t) => t.status)).toEqual(["draft", "draft"]);
  });

  it("rejects Pinterest without an image and a disabled board", async () => {
    const noImage = await api("/posts", { method: "POST", json: { caption: "x", pinterestBoardId: 10 } });
    expect(noImage.status).toBe(400);
    const disabled = await api("/posts", { method: "POST", json: { caption: "x", pinterestBoardId: 11, imageUrl: "https://i.test/a.jpg" } });
    expect(disabled.status).toBe(400);
  });

  it("blocks editing and deleting once a target is published", async () => {
    const post = await createPost();
    await env.DB.prepare("UPDATE post_targets SET status = 'published' WHERE post_id = ?").bind(post.id).run();
    expect((await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "new", facebookAccountId: 1 } })).status).toBe(409);
    expect((await api(`/posts/${post.id}`, { method: "DELETE" })).status).toBe(409);
  });

  it("edits content but keeps the schedule", async () => {
    const post = await createPost({ scheduledAt: inHours(3) });
    const res = await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "new", facebookAccountId: 1 } });
    const edited = (await res.json()) as Post;
    expect(edited.scheduledAt).toBe(post.scheduledAt);
    expect(edited.targets[0]!.status).toBe("scheduled");
  });
});

describe("schedule", () => {
  it("schedules then unschedules every target", async () => {
    const post = await createPost();
    const at = inHours(5);
    const scheduled = (await (await api(`/posts/${post.id}/schedule`, { method: "POST", json: { scheduledAt: at } })).json()) as Post;
    expect(scheduled.targets[0]).toMatchObject({ status: "scheduled", nextAttemptAt: Date.parse(at) });
    const draft = (await (await api(`/posts/${post.id}/unschedule`, { method: "POST" })).json()) as Post;
    expect(draft.scheduledAt).toBeNull();
    expect(draft.targets[0]).toMatchObject({ status: "draft", nextAttemptAt: null });
  });

  it("rejects a time in the past", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}/schedule`, { method: "POST", json: { scheduledAt: "2001-01-01T00:00Z" } });
    expect(res.status).toBe(400);
  });

  it("queues posts into distinct free slots, then 409 when full", async () => {
    // Một slot mỗi tuần → 4 hoặc 5 lần trong 28 ngày tới.
    await api("/slots", { method: "POST", json: { weekday: 1, minuteOfDay: 9 * 60 } });
    const times: number[] = [];
    for (;;) {
      const post = await createPost();
      const res = await api(`/posts/${post.id}/schedule`, { method: "POST", json: { queue: true } });
      if (res.status === 409) break;
      times.push(((await res.json()) as Post).scheduledAt!);
    }
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect(new Set(times).size).toBe(times.length);
    for (const t of times) {
      const local = new Date(t + 7 * 3_600_000);
      expect([local.getUTCDay(), local.getUTCHours(), local.getUTCMinutes()]).toEqual([1, 9, 0]);
    }
  });
});
