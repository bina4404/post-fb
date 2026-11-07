import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron, STUCK_AFTER_MS } from "../src/jobs/cron";
import { handleQueue, publishTarget } from "../src/jobs/publish";
import { encryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { api, DRIVE, seed, seedDrive } from "./helpers";

const GRAPH = "https://graph.facebook.com/v27.0";
const PIN = "https://api.pinterest.test/v5";
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

type Row = Record<string, string | number | null>;
const target = (id: number) => env.DB.prepare("SELECT * FROM post_targets WHERE id = ?").bind(id).first<Row>();
const accountStatus = async (id: number) => (await env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(id).first<Row>())!.status;

/** Tạo bài qua API rồi đặt các target đến hạn ngay. Trả về id các target theo thứ tự facebook, pinterest. */
async function duePost(body: Record<string, unknown>): Promise<number[]> {
  const res = await api("/posts", { method: "POST", json: { caption: "Hello", ...body } });
  const post = (await res.json()) as { id: number; targets: { id: number }[] };
  await env.DB.prepare("UPDATE post_targets SET status = 'scheduled', next_attempt_at = ? WHERE post_id = ?").bind(Date.now() - 1000, post.id).run();
  return post.targets.map((t) => t.id);
}

/** Queue giả: ghi lại message thay vì gửi vào queue thật của miniflare. */
function fakeQueueEnv() {
  const sent: number[] = [];
  const queue = { sendBatch: vi.fn(async (msgs: { body: { targetId: number } }[]) => void sent.push(...msgs.map((m) => m.body.targetId))) };
  return { env: { ...env, PUBLISH_QUEUE: queue as unknown as Queue }, sent };
}

beforeEach(async () => {
  await seed();
  const fb = await encryptToken("PAGE-TOKEN", env.TOKEN_ENC_KEY);
  const pin = await encryptToken("pina_TOKEN", env.TOKEN_ENC_KEY);
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET access_token_enc = ? WHERE id = 1").bind(fb),
    env.DB.prepare("UPDATE accounts SET access_token_enc = ?, access_expires_at = ? WHERE id = 2").bind(pin, Date.now() + 30 * 86_400_000),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("success", () => {
  it("posts a photo from Google Drive to the Page and stores post_id", async () => {
    await seedDrive();
    const [id] = await duePost({ facebookAccountId: 1, link: "https://shop.test", imageKey: "drive-file-123" });
    const calls = mockFetch({
      [`GET ${DRIVE}/files/drive-file-123`]: () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      [`POST ${GRAPH}/page1/photos`]: () => Response.json({ id: "photo1", post_id: "page1_post1" }),
    });

    expect(await publishTarget(env, id!)).toBe("published");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer ya29.ACCESS");
    const form = await calls[1]!.formData();
    expect(form.get("caption")).toBe("Hello\n\nhttps://shop.test");
    expect(form.get("access_token")).toBe("PAGE-TOKEN");
    expect(new Uint8Array(await (form.get("source") as File).arrayBuffer())).toEqual(PNG);
    expect(await target(id!)).toMatchObject({ status: "published", external_post_id: "page1_post1", attempts: 1, locked_at: null });
  });

  it("a Google Drive auth error fails the post without flagging the Facebook account", async () => {
    await seedDrive(0); // access token hết hạn, refresh bị Google từ chối
    const [id] = await duePost({ facebookAccountId: 1, imageKey: "drive-file-123" });
    mockFetch({ "POST https://oauth2.googleapis.com/token": () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }) });
    expect(await publishTarget(env, id!)).toBe("failed");
    expect(await target(id!)).toMatchObject({ status: "failed", last_error: "Google Drive cần kết nối lại" });
    expect(await accountStatus(1)).toBe("ok");
    expect(await accountStatus(3)).toBe("needs_reauth");
  });

  it("posts a link without image to /feed", async () => {
    const [id] = await duePost({ facebookAccountId: 1, link: "https://shop.test" });
    const calls = mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ id: "page1_feed1" }) });
    expect(await publishTarget(env, id!)).toBe("published");
    expect(Object.fromEntries(await calls[0]!.formData())).toEqual({ message: "Hello", link: "https://shop.test", access_token: "PAGE-TOKEN" });
  });

  it("creates a Pin with the image_url downloaded as base64", async () => {
    const [id] = await duePost({ pinterestBoardId: 10, imageUrl: "https://img.test/a.png" });
    const calls = mockFetch({
      "GET https://img.test/a.png": () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      [`POST ${PIN}/pins`]: () => Response.json({ id: "pin1" }),
    });
    expect(await publishTarget(env, id!)).toBe("published");
    const pinReq = calls[1]!;
    expect(pinReq.headers.get("authorization")).toBe("Bearer pina_TOKEN");
    expect(await pinReq.json()).toEqual({
      board_id: "b-ext-1",
      description: "Hello",
      media_source: { source_type: "image_base64", content_type: "image/png", data: btoa(String.fromCharCode(...PNG)) },
    });
    expect((await target(id!))!.external_post_id).toBe("pin1");
  });
});

describe("transient errors", () => {
  it("retries 3 times with 2/4/8 min backoff, then fails", async () => {
    const [id] = await duePost({ facebookAccountId: 1 });
    const calls = mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ error: { message: "Service down", code: 2 } }, { status: 500 }) });
    let now = Date.now();
    for (const minutes of [2, 4, 8]) {
      expect(await publishTarget(env, id!, now)).toBe("retry");
      expect(await target(id!)).toMatchObject({ status: "scheduled", next_attempt_at: now + minutes * 60_000, last_error: "Service down" });
      expect(await publishTarget(env, id!, now)).toBe("skipped"); // chưa tới giờ retry
      now += minutes * 60_000;
    }
    expect(await publishTarget(env, id!, now)).toBe("failed");
    expect(await target(id!)).toMatchObject({ status: "failed", attempts: 4, needs_attention: 1 });
    expect(calls).toHaveLength(4);
  });

  it("treats a network timeout as transient", async () => {
    const [id] = await duePost({ facebookAccountId: 1 });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await publishTarget(env, id!)).toBe("retry");
  });
});

describe("permanent errors", () => {
  it("stops on a permission error and flags the target", async () => {
    const [id] = await duePost({ facebookAccountId: 1 });
    mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ error: { message: "(#200) Requires pages_manage_posts", code: 200 } }, { status: 403 }) });
    expect(await publishTarget(env, id!)).toBe("failed");
    expect(await target(id!)).toMatchObject({ status: "failed", attempts: 1, needs_attention: 1, last_error: "(#200) Requires pages_manage_posts" });
    expect(await accountStatus(1)).toBe("ok");
  });

  it("on an expired token fails the target, marks the account and holds its other posts", async () => {
    const [first] = await duePost({ facebookAccountId: 1 });
    const [second] = await duePost({ facebookAccountId: 1 });
    mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ error: { message: "Session has expired", code: 190 } }, { status: 400 }) });
    expect(await publishTarget(env, first!)).toBe("failed");
    expect(await accountStatus(1)).toBe("needs_reauth");

    const { env: cronEnv, sent } = fakeQueueEnv();
    await runCron(cronEnv);
    expect(sent).toEqual([]);
    expect((await target(second!))!.status).toBe("scheduled");
  });
});

describe("idempotency", () => {
  it("publishes once even when cron runs twice and messages are duplicated", async () => {
    const [id] = await duePost({ facebookAccountId: 1 });
    const { env: cronEnv, sent } = fakeQueueEnv();
    await runCron(cronEnv);
    await runCron(cronEnv);
    expect(sent).toEqual([id, id]);

    const calls = mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ id: "page1_once" }) });
    const results = await Promise.all(sent.map((targetId) => publishTarget(env, targetId)));
    expect(results.sort()).toEqual(["published", "skipped"]);
    expect(calls).toHaveLength(1);
  });

  it("never re-publishes a target stuck in publishing; flags it after 20 minutes", async () => {
    const [id] = await duePost({ facebookAccountId: 1 });
    const now = Date.now();
    await env.DB.prepare("UPDATE post_targets SET status = 'publishing', locked_at = ? WHERE id = ?").bind(now - STUCK_AFTER_MS + 60_000, id).run();
    const { env: cronEnv, sent } = fakeQueueEnv();
    await runCron(cronEnv, now);
    expect((await target(id!))!.status).toBe("publishing");

    await runCron(cronEnv, now + 120_000);
    expect(await target(id!)).toMatchObject({ status: "failed", needs_attention: 1 });
    expect(sent).toEqual([]);
  });

  it("does not enqueue future, draft or disabled-account targets", async () => {
    const [due] = await duePost({ facebookAccountId: 1 });
    const [, pinDue] = await duePost({ facebookAccountId: 1, pinterestBoardId: 10, imageUrl: "https://img.test/a.png" });
    await api("/posts", { method: "POST", json: { caption: "draft", facebookAccountId: 1 } });
    await env.DB.prepare("UPDATE accounts SET enabled = 0 WHERE id = 2").run();
    const { env: cronEnv, sent } = fakeQueueEnv();
    await runCron(cronEnv);
    expect(sent).toContain(due);
    expect(sent).not.toContain(pinDue);
    expect(sent).toHaveLength(2);
  });
});

it("queue consumer acks every message, even when publishing crashes", async () => {
  const [id] = await duePost({ facebookAccountId: 1 });
  mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ id: "x" }) });
  const ack = vi.fn();
  const msg = (targetId: number) => ({ body: { targetId }, ack, retry: vi.fn() });
  await handleQueue({ messages: [msg(id!), msg(-1)] } as unknown as MessageBatch<{ targetId: number }>, env);
  expect(ack).toHaveBeenCalledTimes(2);
  expect((await target(id!))!.status).toBe("published");
});
