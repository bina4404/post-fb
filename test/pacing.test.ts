import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../src/jobs/cron";
import { publishTarget } from "../src/jobs/publish";
import { encryptToken } from "../src/lib/crypto";
import { PAGE_DAILY_CAP, PAGE_MIN_GAP_MS, staggerDelays } from "../src/lib/pacing";
import { mockFetch } from "./fetch-mock";
import { api, seed } from "./helpers";

const GRAPH = "https://graph.facebook.com/v27.0";
type Row = Record<string, string | number | null>;
const target = (id: number) => env.DB.prepare("SELECT * FROM post_targets WHERE id = ?").bind(id).first<Row>();
const accountStatus = async (id: number) => (await env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(id).first<Row>())!.status;

async function duePost(pageIds = [1]): Promise<number[]> {
  const res = await api("/posts", { method: "POST", json: { caption: "Hello", facebookAccountIds: pageIds } });
  const post = (await res.json()) as { id: number; targets: { id: number }[] };
  await env.DB.prepare("UPDATE post_targets SET status = 'scheduled', next_attempt_at = ? WHERE post_id = ?").bind(Date.now() - 1000, post.id).run();
  return post.targets.map((t) => t.id);
}

function fakeQueueEnv() {
  const sent: number[] = [];
  const queue = { sendBatch: async (msgs: { body: { targetId: number } }[]) => void sent.push(...msgs.map((m) => m.body.targetId)) };
  return { env: { ...env, PUBLISH_QUEUE: queue as unknown as Queue }, sent };
}

beforeEach(async () => {
  await seed();
  await env.DB.prepare("UPDATE accounts SET access_token_enc = ?, enabled = 1").bind(await encryptToken("PAGE-TOKEN", env.TOKEN_ENC_KEY)).run();
});
afterEach(() => vi.restoreAllMocks());

describe("stagger", () => {
  it("spreads the Pages of one post 30–90 s apart, and posts independently", () => {
    const plan = staggerDelays(
      [
        { id: 1, postId: 7 },
        { id: 2, postId: 7 },
        { id: 3, postId: 7 },
        { id: 4, postId: 8 },
      ],
      () => 0.5,
    );
    expect(plan).toEqual([
      { id: 1, delay: 15 },
      { id: 2, delay: 15 + 60 },
      { id: 3, delay: 15 + 60 + 60 },
      { id: 4, delay: 15 },
    ]);
  });
});

describe("per-Page spacing", () => {
  it("waits 10 minutes after the last post on the same Page, without using up an attempt", async () => {
    const [first] = await duePost();
    const [second] = await duePost();
    mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ id: "page1_x" }) });
    const now = Date.now();
    expect(await publishTarget(env, first!, now)).toBe("published");
    expect(await publishTarget(env, second!, now + 60_000)).toBe("waiting");
    const row = await target(second!);
    expect(row).toMatchObject({ status: "scheduled", attempts: 0 });
    expect(Number(row!.next_attempt_at)).toBeGreaterThanOrEqual(now + PAGE_MIN_GAP_MS);
    expect(Number(row!.next_attempt_at)).toBeLessThanOrEqual(now + PAGE_MIN_GAP_MS + 30_000);
  });

  it("does not delay a different Page", async () => {
    const [onPage1] = await duePost([1]);
    const [onPage2] = await duePost([2]);
    mockFetch({
      [`POST ${GRAPH}/page1/feed`]: () => Response.json({ id: "page1_x" }),
      [`POST ${GRAPH}/page2/feed`]: () => Response.json({ id: "page2_x" }),
    });
    expect(await publishTarget(env, onPage1!)).toBe("published");
    expect(await publishTarget(env, onPage2!)).toBe("published");
  });

  it(`caps a Page at ${PAGE_DAILY_CAP} posts per 24 hours`, async () => {
    const now = Date.now();
    const [due] = await duePost();
    const postId = Number((await target(due!))!.post_id);
    const inserts = Array.from({ length: PAGE_DAILY_CAP }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO post_targets (post_id, platform, account_id, status, idempotency_key, updated_at) VALUES (?, 'facebook', 1, 'published', ?, ?)",
      ).bind(postId, `old-${i}`, now - 23 * 3_600_000 + i * 60_000),
    );
    await env.DB.batch(inserts);
    expect(await publishTarget(env, due!, now)).toBe("waiting");
    // Được đăng lại khi bài cũ nhất trong 24 giờ qua hết hạn.
    expect(Number((await target(due!))!.next_attempt_at)).toBeGreaterThanOrEqual(now + 3_600_000);
  });

  it("cron sends at most one post per Page per run", async () => {
    const [a] = await duePost([1]);
    const [b] = await duePost([1]);
    const [c] = await duePost([2]);
    const { env: cronEnv, sent } = fakeQueueEnv();
    await runCron(cronEnv);
    expect(sent.sort()).toEqual([a, c].sort());
    expect(sent).not.toContain(b);
  });
});

describe("Facebook limits", () => {
  it("backs off 15 minutes on a rate-limit error (code 32)", async () => {
    const [id] = await duePost();
    mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ error: { message: "Page request limit reached", code: 32 } }, { status: 400 }) });
    const now = Date.now();
    expect(await publishTarget(env, id!, now)).toBe("retry");
    expect(await target(id!)).toMatchObject({ status: "scheduled", next_attempt_at: now + 15 * 60_000, last_error: "Page request limit reached" });
  });

  it("pauses the Page when Facebook blocks it for abuse (code 368), and cron skips its other posts", async () => {
    const [blocked] = await duePost([1]);
    const [other] = await duePost([1]);
    mockFetch({ [`POST ${GRAPH}/page1/feed`]: () => Response.json({ error: { message: "deemed abusive", code: 368 } }, { status: 400 }) });
    expect(await publishTarget(env, blocked!)).toBe("failed");
    expect(await target(blocked!)).toMatchObject({ status: "failed", needs_attention: 1 });
    expect(await accountStatus(1)).toBe("paused");

    const { env: cronEnv, sent } = fakeQueueEnv();
    await runCron(cronEnv, Date.now() + PAGE_MIN_GAP_MS);
    expect(sent).not.toContain(other);
  });
});
