import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../src/jobs/cron";
import { encryptToken } from "../src/lib/crypto";
import { api, inHours, seed } from "./helpers";

type Row = { id: number; platform: string; status: string; destination: string; boardName: string | null; scheduledAt: number };

async function createPost(body: Record<string, unknown>) {
  const res = await api("/posts", { method: "POST", json: { caption: "c", ...body } });
  return ((await res.json()) as { targets: { id: number }[] }).targets.map((t) => t.id);
}

const list = async (query = "") => (await (await api(`/targets${query}`)).json()) as Row[];
const setTarget = (id: number, sql: string) => env.DB.prepare(`UPDATE post_targets SET ${sql} WHERE id = ?`).bind(id).run();

beforeEach(seed);

describe("GET /api/targets", () => {
  it("lists one row per target with destination names, filterable by platform, status and time", async () => {
    const [fb, pin] = await createPost({ facebookAccountId: 1, pinterestBoardId: 10, imageUrl: "https://i.test/a.jpg", scheduledAt: inHours(2) });
    await createPost({ facebookAccountId: 1, scheduledAt: inHours(48) });
    await setTarget(pin!, "status = 'failed'");

    expect(await list()).toHaveLength(3);
    expect((await list("?platform=pinterest")).map((r) => [r.id, r.destination, r.boardName])).toEqual([[pin, "Pin User", "Recipes"]]);
    expect((await list("?status=failed")).map((r) => r.id)).toEqual([pin]);
    const from = Date.now();
    const to = from + 24 * 3_600_000;
    expect((await list(`?from=${from}&to=${to}`)).map((r) => r.id).sort()).toEqual([fb, pin].sort());
  });

  it("rejects an unknown status", async () => {
    expect((await api("/targets?status=done")).status).toBe(400);
  });
});

describe("POST /api/targets/:id/retry", () => {
  it("puts a failed target back in the queue and cron sends it on the next run", async () => {
    const [id] = await createPost({ facebookAccountId: 1, scheduledAt: inHours(1) });
    await setTarget(id!, "status = 'failed', attempts = 4, needs_attention = 1, last_error = 'boom'");
    await env.DB.prepare("UPDATE accounts SET access_token_enc = ? WHERE id = 1").bind(await encryptToken("t", env.TOKEN_ENC_KEY)).run();

    expect((await api(`/targets/${id}/retry`, { method: "POST" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT status, attempts, needs_attention, last_error FROM post_targets WHERE id = ?").bind(id).first();
    expect(row).toEqual({ status: "scheduled", attempts: 0, needs_attention: 0, last_error: null });

    const sendBatch = vi.fn();
    await runCron({ ...env, PUBLISH_QUEUE: { sendBatch } as unknown as Queue }, Date.now() + 1000);
    expect(sendBatch).toHaveBeenCalledWith([{ body: { targetId: id } }]);
  });

  it("refuses targets that are not failed or already exist on the platform", async () => {
    const [scheduled] = await createPost({ facebookAccountId: 1, scheduledAt: inHours(1) });
    expect((await api(`/targets/${scheduled}/retry`, { method: "POST" })).status).toBe(409);
    const [published] = await createPost({ facebookAccountId: 1 });
    await setTarget(published!, "status = 'failed', external_post_id = 'page1_123'");
    expect((await api(`/targets/${published}/retry`, { method: "POST" })).status).toBe(409);
  });
});
