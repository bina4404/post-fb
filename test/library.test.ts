import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, count, inHours, seed } from "./helpers";

type Page = { items: { id: number; caption: string; scheduledAt: number | null }[]; counts: Record<string, number>; total: number; pageSize: number };

async function create(caption: string, body: Record<string, unknown> = {}) {
  const res = await api("/posts", { method: "POST", json: { caption, facebookAccountIds: [1], ...body } });
  return (await res.json()) as { id: number; targets: { id: number; accountId: number }[] };
}
const setStatus = (targetId: number, status: string) => env.DB.prepare("UPDATE post_targets SET status = ? WHERE id = ?").bind(status, targetId).run();
const list = async (query = "") => (await (await api(`/posts${query}`)).json()) as Page;

beforeEach(async () => {
  await seed();
  await env.DB.prepare("UPDATE accounts SET enabled = 1").run();
});

describe("library list", () => {
  it("groups posts by status, counts each group and sorts each group usefully", async () => {
    await create("draft one");
    const b = await create("in two hours", { scheduledAt: inHours(2) });
    const c = await create("in one hour", { scheduledAt: inHours(1) });
    const d = await create("broken", { scheduledAt: inHours(4) });
    await setStatus(d.targets[0]!.id, "failed");
    const e = await create("done");
    await setStatus(e.targets[0]!.id, "published");
    // Một Page đã đăng, một Page còn chờ: bài vẫn thuộc nhóm "Đã lên lịch".
    const f = await create("half done", { scheduledAt: inHours(3), facebookAccountIds: [1, 2] });
    await setStatus(f.targets[0]!.id, "published");

    const all = await list();
    expect(all.counts).toEqual({ all: 6, draft: 1, scheduled: 3, failed: 1, published: 1 });
    expect((await list("?group=scheduled")).items.map((p) => p.id)).toEqual([c.id, b.id, f.id]); // sắp đăng lên trước
    expect((await list("?group=failed")).items.map((p) => p.id)).toEqual([d.id]);
    expect((await list("?group=published")).items.map((p) => p.id)).toEqual([e.id]);
  });

  it("filters by Page and by caption text, and the counts follow the filters", async () => {
    await create("Hello World");
    await create("other post", { facebookAccountIds: [2] });
    expect((await list("?page=2")).counts.all).toBe(1);
    const found = await list("?q=hello");
    expect(found.items.map((p) => p.caption)).toEqual(["Hello World"]);
    expect(found.counts.all).toBe(1);
    expect((await list("?q=50%25_off")).items).toEqual([]); // ký tự % _ không làm khớp bừa
  });

  it("pages through 50 posts at a time", async () => {
    await env.DB.batch(
      Array.from({ length: 55 }, (_, i) =>
        env.DB.prepare("INSERT INTO posts (caption, created_at, updated_at) VALUES (?, ?, ?)").bind(`p${i}`, i, i),
      ),
    );
    await env.DB.prepare(
      "INSERT INTO post_targets (post_id, platform, account_id, status, idempotency_key, updated_at) SELECT id, 'facebook', 1, 'draft', id || ':facebook:1', 0 FROM posts",
    ).run();
    const first = await list("?group=draft");
    expect([first.items.length, first.total, first.pageSize]).toEqual([50, 55, 50]);
    expect((await list("?group=draft&offset=50")).items).toHaveLength(5);
  });

  it("rejects an unknown group", async () => {
    expect((await api("/posts?group=archived")).status).toBe(400);
  });
});

describe("bulk actions", () => {
  it("queues drafts into distinct free slots and skips posts with nothing left to send", async () => {
    await api("/slots", { method: "POST", json: { weekday: 1, minuteOfDay: 9 * 60 } });
    await api("/slots", { method: "POST", json: { weekday: 3, minuteOfDay: 9 * 60 } });
    const drafts = [await create("a"), await create("b"), await create("c")];
    const done = await create("already out");
    await setStatus(done.targets[0]!.id, "published");

    const res = await api("/posts/bulk", { method: "POST", json: { action: "queue", ids: [...drafts.map((p) => p.id), done.id] } });
    const body = (await res.json()) as { done: number[]; skipped: { id: number; reason: string }[] };
    expect(body.done).toEqual(drafts.map((p) => p.id));
    expect(body.skipped).toEqual([{ id: done.id, reason: "không còn Page nào chờ đăng" }]);
    const times = (await list("?group=scheduled")).items.map((p) => p.scheduledAt);
    expect(new Set(times).size).toBe(3);
  });

  it("reports the rest as skipped when free slots run out", async () => {
    const posts = [await create("a"), await create("b")];
    const res = await api("/posts/bulk", { method: "POST", json: { action: "queue", ids: posts.map((p) => p.id) } });
    expect(((await res.json()) as { skipped: unknown[] }).skipped).toHaveLength(2);
  });

  it("deletes editable posts and keeps posts that are already out", async () => {
    const keep = await create("published");
    await setStatus(keep.targets[0]!.id, "published");
    const drop = await create("draft");
    const res = await api("/posts/bulk", { method: "POST", json: { action: "delete", ids: [keep.id, drop.id] } });
    expect(await res.json()).toEqual({ done: [drop.id], skipped: [{ id: keep.id, reason: "đã/đang đăng hoặc không tồn tại" }] });
    expect(await count("posts")).toBe(1);
  });
});
