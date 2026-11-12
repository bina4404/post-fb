import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptToken } from "../src/lib/crypto";
import { api, seed } from "./helpers";

type Row = { id: number; image_key: string; caption: string; scheduled_at: number; account_id: number; status: string; idempotency_key: string };
const autoPosts = async (accountId = 1) =>
  (
    await env.DB.prepare(
      "SELECT p.id, p.image_key, p.caption, p.scheduled_at, t.account_id, t.status, t.idempotency_key FROM posts p JOIN post_targets t ON t.post_id = p.id WHERE t.idempotency_key LIKE 'auto:%' AND t.account_id = ? ORDER BY p.scheduled_at",
    )
      .bind(accountId)
      .all<Row>()
  ).results;

async function addImages(n: number, captions = ["Caption A", "Caption B"]) {
  const now = Date.now();
  await env.DB.batch(
    Array.from({ length: n }, (_, i) =>
      env.DB.prepare("INSERT INTO images (drive_file_id, name, captions, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(`drive-img-${i}`, `img-${i}.jpg`, JSON.stringify(captions), now, now),
    ),
  );
}
const setPage = (id: number, body: unknown) => api(`/auto/pages/${id}`, { method: "PUT", json: body });

beforeEach(async () => {
  await seed();
  await env.DB.prepare("UPDATE accounts SET access_token_enc = ?, enabled = 1").bind(await encryptToken("PAGE-TOKEN", env.TOKEN_ENC_KEY)).run();
});

describe("auto posting", () => {
  it("fills the next 7 days of a Page with distinct images, and re-planning creates no duplicates", async () => {
    await addImages(20);
    const res = await setPage(1, { autoEnabled: true, times: [9 * 60, 20 * 60] });
    const { created, shortages } = (await res.json()) as { created: number; shortages: number };
    const rows = await autoPosts();
    expect(created).toBe(rows.length);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(shortages).toBe(0);
    expect(new Set(rows.map((r) => r.image_key)).size).toBe(rows.length); // không lặp ảnh trong 7 ngày
    expect(rows.every((r) => r.status === "scheduled" && ["Caption A", "Caption B"].includes(r.caption))).toBe(true);
    expect(rows.every((r) => r.idempotency_key === `auto:1:${r.scheduled_at}`)).toBe(true);

    expect(await (await api("/auto/plan", { method: "POST" })).json()).toEqual({ created: 0, shortages: 0 });
    const overview = (await (await api("/auto")).json()) as { pages: { id: number; times: number[]; upcoming: number }[]; readyImages: number; minImagesNeeded: number };
    expect(overview.pages.find((p) => p.id === 1)).toMatchObject({ times: [540, 1200], upcoming: rows.length });
    expect([overview.readyImages, overview.minImagesNeeded]).toEqual([20, 14]);
  });

  it("leaves slots empty rather than repeating when there are not enough images", async () => {
    await addImages(3);
    const body = (await (await setPage(1, { autoEnabled: true, times: [9 * 60, 20 * 60] })).json()) as { created: number; shortages: number };
    expect(body.created).toBe(3);
    expect(body.shortages).toBeGreaterThan(0);
  });

  it("never uses one image on two Pages within 24 hours", async () => {
    await addImages(30);
    await setPage(1, { autoEnabled: true, times: [9 * 60] });
    await setPage(2, { autoEnabled: true, times: [9 * 60 + 30] });
    const all = [...(await autoPosts(1)), ...(await autoPosts(2))];
    for (const a of all) {
      const clash = all.find((b) => b !== a && b.account_id !== a.account_id && b.image_key === a.image_key && Math.abs(b.scheduled_at - a.scheduled_at) < 24 * 3_600_000);
      expect(clash).toBeUndefined();
    }
  });

  it("turning auto off removes the Page's unsent auto posts", async () => {
    await addImages(20);
    await setPage(1, { autoEnabled: true, times: [9 * 60] });
    expect((await autoPosts()).length).toBeGreaterThan(0);
    await setPage(1, { autoEnabled: false, times: [9 * 60] });
    expect(await autoPosts()).toEqual([]);
  });

  it("disabling an image replaces it in future posts; editing captions updates them", async () => {
    await addImages(20);
    await setPage(1, { autoEnabled: true, times: [9 * 60] });
    const first = (await autoPosts())[0]!;
    const image = await env.DB.prepare("SELECT id FROM images WHERE drive_file_id = ?").bind(first.image_key).first<{ id: number }>();
    await api(`/images/${image!.id}`, { method: "PATCH", json: { enabled: false } });
    expect((await autoPosts()).some((r) => r.image_key === first.image_key)).toBe(false);

    const second = (await autoPosts())[0]!;
    const other = await env.DB.prepare("SELECT id FROM images WHERE drive_file_id = ?").bind(second.image_key).first<{ id: number }>();
    await api(`/images/${other!.id}`, { method: "PATCH", json: { captions: ["New caption", ""] } });
    expect((await autoPosts()).find((r) => r.image_key === second.image_key)!.caption).toBe("New caption");
  });

  it("validates Page times", async () => {
    expect((await setPage(1, { autoEnabled: true, times: [540, 545] })).status).toBe(400); // cách nhau < 10 phút
    expect((await setPage(1, { autoEnabled: true, times: [3, 1435] })).status).toBe(400); // 8 phút, qua nửa đêm
    expect((await setPage(1, { autoEnabled: true, times: [540, 540] })).status).toBe(400);
    expect((await setPage(1, { autoEnabled: true, times: Array.from({ length: 26 }, (_, i) => i * 30) })).status).toBe(400);
    expect((await setPage(99, { autoEnabled: true, times: [] })).status).toBe(404);
  });
});
