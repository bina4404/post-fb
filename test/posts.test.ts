import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, inHours, seed } from "./helpers";

type Post = { id: number; scheduledAt: number | null; targets: { id: number; status: string; nextAttemptAt: number | null }[] };

async function createPost(body: Record<string, unknown> = {}) {
  const res = await api("/posts", { method: "POST", json: { caption: "hi", facebookAccountIds: [1], ...body } });
  expect(res.status).toBe(201);
  return (await res.json()) as Post;
}

beforeEach(seed);

describe("posts", () => {
  it("creates a draft for the chosen Page", async () => {
    const post = await createPost({ imageUrl: "https://i.test/a.jpg" });
    expect(post.scheduledAt).toBeNull();
    expect(post.targets.map((t) => t.status)).toEqual(["draft"]);
  });

  it("rejects a missing or disabled Page", async () => {
    expect((await api("/posts", { method: "POST", json: { caption: "x" } })).status).toBe(400);
    expect((await api("/posts", { method: "POST", json: { caption: "x", facebookAccountIds: [2] } })).status).toBe(400);
  });

  it("blocks editing and deleting once a target is published", async () => {
    const post = await createPost();
    await env.DB.prepare("UPDATE post_targets SET status = 'published' WHERE post_id = ?").bind(post.id).run();
    expect((await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "new", facebookAccountIds: [1] } })).status).toBe(409);
    expect((await api(`/posts/${post.id}`, { method: "DELETE" })).status).toBe(409);
  });

  it("edits content but keeps the schedule", async () => {
    const post = await createPost({ scheduledAt: inHours(3) });
    const res = await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "new", facebookAccountIds: [1] } });
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

describe("several Pages per post", () => {
  beforeEach(() => env.DB.prepare("UPDATE accounts SET enabled = 1").run());

  it("creates one target per Page, ignoring duplicates", async () => {
    const res = await api("/posts", { method: "POST", json: { caption: "x", facebookAccountIds: [1, 2, 1] } });
    const post = (await res.json()) as { targets: { accountId: number; idempotencyKey: string }[] };
    expect(post.targets.map((t) => t.accountId).sort()).toEqual([1, 2]);
    expect(new Set(post.targets.map((t) => t.idempotencyKey)).size).toBe(2);
  });

  it("editing replaces the set of Pages", async () => {
    const post = await createPost({ facebookAccountIds: [1, 2] });
    const res = await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "x", facebookAccountIds: [2] } });
    expect(((await res.json()) as { targets: { accountId: number }[] }).targets.map((t) => t.accountId)).toEqual([2]);
  });

  it("rejects the whole post if any Page is disabled", async () => {
    await env.DB.prepare("UPDATE accounts SET enabled = 0 WHERE id = 2").run();
    expect((await api("/posts", { method: "POST", json: { caption: "x", facebookAccountIds: [1, 2] } })).status).toBe(400);
  });
});

describe("publish now", () => {
  it("schedules every unpublished target for now and sends them to the queue", async () => {
    await env.DB.prepare("UPDATE accounts SET enabled = 1").run();
    const post = await createPost({ facebookAccountIds: [1, 2] });
    const sent: number[] = [];
    const delays: number[] = [];
    const queue = {
      sendBatch: async (msgs: { body: { targetId: number }; delaySeconds: number }[]) =>
        void msgs.forEach((m) => (sent.push(m.body.targetId), delays.push(m.delaySeconds))),
    };
    const before = Date.now();
    const res = await api(`/posts/${post.id}/publish-now`, { method: "POST" }, { PUBLISH_QUEUE: queue as unknown as Queue });
    const updated = (await res.json()) as Post;
    expect(sent.sort()).toEqual(updated.targets.map((t) => t.id).sort());
    // Page đầu: trễ 0–30 giây; Page sau: thêm 30–90 giây, không đăng đồng loạt.
    expect(delays[0]).toBeLessThanOrEqual(30);
    expect(delays[1]! - delays[0]!).toBeGreaterThanOrEqual(30);
    expect(delays[1]! - delays[0]!).toBeLessThanOrEqual(90);
    for (const t of updated.targets) {
      expect(t.status).toBe("scheduled");
      expect(t.nextAttemptAt).toBeGreaterThanOrEqual(before);
      expect(t.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 120_000);
    }
  });

  it("does not resend targets that are already published", async () => {
    const post = await createPost();
    await env.DB.prepare("UPDATE post_targets SET status = 'published' WHERE post_id = ?").bind(post.id).run();
    const sent: unknown[] = [];
    const queue = { sendBatch: async (msgs: unknown[]) => void sent.push(...msgs) };
    expect((await api(`/posts/${post.id}/publish-now`, { method: "POST" }, { PUBLISH_QUEUE: queue as unknown as Queue })).status).toBe(200);
    expect(sent).toEqual([]);
  });
});

describe("never re-send a Page that may already have the post", () => {
  const UNKNOWN = "không rõ kết quả (Worker dừng giữa lúc đăng), hãy kiểm tra trên nền tảng trước khi đăng lại";
  async function postWithUnknownPage() {
    await env.DB.prepare("UPDATE accounts SET enabled = 1").run();
    const post = await createPost({ facebookAccountIds: [1, 2] });
    const [stuck, other] = post.targets;
    await env.DB.prepare("UPDATE post_targets SET status = 'failed', needs_attention = 1, last_error = ? WHERE id = ?").bind(UNKNOWN, stuck!.id).run();
    return { post, stuck: stuck!, other: other! };
  }

  it("publish now and re-scheduling leave a failed target alone", async () => {
    const { post, stuck, other } = await postWithUnknownPage();
    const sent: number[] = [];
    const queue = { sendBatch: async (msgs: { body: { targetId: number } }[]) => void sent.push(...msgs.map((m) => m.body.targetId)) };
    await api(`/posts/${post.id}/publish-now`, { method: "POST" }, { PUBLISH_QUEUE: queue as unknown as Queue });
    expect(sent).toEqual([other.id]);
    await api(`/posts/${post.id}/schedule`, { method: "POST", json: { scheduledAt: inHours(2) } });
    const row = await env.DB.prepare("SELECT status, last_error FROM post_targets WHERE id = ?").bind(stuck.id).first();
    expect(row).toEqual({ status: "failed", last_error: UNKNOWN });
  });

  it("editing is blocked while a Page has an unknown outcome, deleting is allowed", async () => {
    const { post } = await postWithUnknownPage();
    expect((await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "x", facebookAccountIds: [1, 2] } })).status).toBe(409);
    expect((await api(`/posts/${post.id}`, { method: "DELETE" })).status).toBe(204);
  });
});

describe("cross-site requests (CSRF)", () => {
  it("rejects writes sent from another site, allows same-origin and non-browser clients", async () => {
    const post = await createPost();
    const cross = await api(`/posts/${post.id}`, { method: "DELETE", headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(cross.status).toBe(403);
    const otherOrigin = await api(`/posts/${post.id}`, { method: "DELETE", headers: { Origin: "https://evil.example" } });
    expect(otherOrigin.status).toBe(403);
    const sameOrigin = await api(`/posts/${post.id}`, { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin", Origin: "http://localhost" } });
    expect(sameOrigin.status).toBe(204);
    expect((await api("/posts", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(200); // GET vẫn đọc được
  });
});

describe("many Pages and large selections (D1 allows at most 100 parameters per query)", () => {
  it("creates and edits a post for 30 Pages at once", async () => {
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 28 }, (_, i) =>
        env.DB.prepare("INSERT INTO accounts (id, platform, external_id, name, enabled, updated_at) VALUES (?, 'facebook', ?, ?, 1, ?)").bind(100 + i, `p${i}`, `Page ${i}`, now),
      ),
    );
    await env.DB.prepare("UPDATE accounts SET enabled = 1").run();
    const ids = [1, 2, ...Array.from({ length: 28 }, (_, i) => 100 + i)];
    const res = await api("/posts", { method: "POST", json: { caption: "x", facebookAccountIds: ids, scheduledAt: inHours(2) } });
    expect(res.status).toBe(201);
    const post = (await res.json()) as Post;
    expect(post.targets).toHaveLength(30);
    const edit = await api(`/posts/${post.id}`, { method: "PATCH", json: { caption: "y", facebookAccountIds: ids } });
    expect(edit.status).toBe(200);
  });

  it("bulk-deletes more than 100 selected posts", async () => {
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 120 }, (_, i) => env.DB.prepare("INSERT INTO posts (id, caption, created_at, updated_at) VALUES (?, 'x', ?, ?)").bind(1000 + i, now, now)));
    const res = await api("/posts/bulk", { method: "POST", json: { action: "delete", ids: Array.from({ length: 120 }, (_, i) => 1000 + i) } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { done: number[] }).done).toHaveLength(120);
  });
});
