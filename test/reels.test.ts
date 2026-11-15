import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncDriveImages, syncReelVideos } from "../src/jobs/drive-sync";
import { planAutoPosts } from "../src/jobs/planner";
import { publishTarget } from "../src/jobs/publish";
import { getDb } from "../src/db/client";
import { encryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { api, DRIVE, seed, seedDrive } from "./helpers";

const GRAPH = "https://graph.facebook.com/v27.0";
const RUPLOAD = "https://rupload.facebook.com/video-upload/v27.0/vid-1";
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
type Row = Record<string, string | number | null>;

/** Drive giả: mỗi thư mục có danh sách video riêng; thư mục post-fb có `images`. */
function driveWith(folders: Record<string, { id: string; name: string; ms?: number }[]>, images: { id: string; name: string }[] = []) {
  return mockFetch({
    [`GET ${DRIVE}/files`]: (req) => {
      const q = new URL(req.url).searchParams.get("q") ?? "";
      if (q.startsWith("name = 'post-fb'")) return Response.json({ files: [{ id: "postfb" }] });
      if (q.includes("'postfb' in parents")) return Response.json({ files: images });
      const folder = Object.keys(folders).find((f) => q.includes(`'${f}' in parents`));
      const files = (folder ? folders[folder]! : []).map((v) => ({ id: v.id, name: v.name, videoMediaMetadata: v.ms ? { durationMillis: String(v.ms) } : undefined }));
      return Response.json({ files });
    },
  });
}

beforeEach(async () => {
  await seed();
  await seedDrive();
  const fb = await encryptToken("PAGE-TOKEN", env.TOKEN_ENC_KEY);
  await env.DB.prepare("UPDATE accounts SET access_token_enc = ?, enabled = 1, auto_enabled = 1 WHERE platform = 'facebook'").bind(fb).run();
});
afterEach(() => vi.restoreAllMocks());

describe("publish a Reel", () => {
  it("starts, streams the Drive video to rupload, then finishes with the caption", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO posts (id, kind, caption, image_key, scheduled_at, created_at, updated_at) VALUES (1, 'reel', 'Hi reel', 'video-file-1', ?, ?, ?)").bind(now, now, now).run();
    await env.DB.prepare("INSERT INTO post_targets (id, post_id, platform, account_id, status, idempotency_key, next_attempt_at, updated_at) VALUES (1, 1, 'facebook', 1, 'scheduled', 'k1', ?, ?)").bind(now - 1000, now).run();
    const calls = mockFetch({
      [`GET ${DRIVE}/files/video-file-1`]: () => new Response(MP4, { headers: { "content-type": "video/mp4", "content-length": String(MP4.length) } }),
      [`POST ${GRAPH}/page1/video_reels`]: async (req) => {
        const form = new URLSearchParams(await req.text());
        return form.get("upload_phase") === "start" ? Response.json({ video_id: "vid-1", upload_url: RUPLOAD }) : Response.json({ success: true });
      },
      [`POST ${RUPLOAD}`]: async (req) => (await req.arrayBuffer(), Response.json({ success: true })),
    });

    expect(await publishTarget(env, 1)).toBe("published");
    const upload = calls.find((c) => c.url === RUPLOAD)!;
    expect(upload.headers.get("authorization")).toBe("OAuth PAGE-TOKEN");
    expect(upload.headers.get("file_size")).toBe(String(MP4.length));
    expect(new Uint8Array(await upload.arrayBuffer())).toEqual(MP4);
    const finish = new URLSearchParams(await calls.at(-1)!.text());
    expect(Object.fromEntries(finish)).toMatchObject({ upload_phase: "finish", video_id: "vid-1", video_state: "PUBLISHED", description: "Hi reel" });
    expect(await env.DB.prepare("SELECT status, external_post_id FROM post_targets WHERE id = 1").first()).toEqual({ status: "published", external_post_id: "vid-1" });
  });
});

describe("sync Reels folders", () => {
  it("imports videos per folder, skips ones longer than 90s, and image sync leaves videos alone", async () => {
    await env.DB.prepare("UPDATE accounts SET reel_folder_id = 'fold-a' WHERE platform = 'facebook'").run(); // 2 Page dùng chung thư mục
    driveWith({ "fold-a": [{ id: "vid-short", name: "a.mp4", ms: 30_000 }, { id: "vid-long", name: "b.mp4", ms: 300_000 }] }, [{ id: "img-1", name: "x.jpg" }]);
    const db = getDb(env);
    expect(await syncReelVideos(db, env, Date.now())).toMatchObject({ added: 1, skipped: 1, total: 1 });
    await syncDriveImages(db, env, Date.now());
    const rows = await env.DB.prepare("SELECT drive_file_id, kind, folder_id, enabled FROM images ORDER BY drive_file_id").all<Row>();
    expect(rows.results).toEqual([
      { drive_file_id: "img-1", kind: "image", folder_id: null, enabled: 1 },
      { drive_file_id: "vid-short", kind: "reel", folder_id: "fold-a", enabled: 1 },
    ]);
  });
});

describe("plan Reels", () => {
  it("Reels slots use only videos from the Page's own folder; image slots never get a video", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE accounts SET reel_folder_id = 'fold-a' WHERE id = 1"),
      env.DB.prepare("UPDATE accounts SET reel_folder_id = 'fold-b' WHERE id = 2"),
      env.DB.prepare(
        "INSERT INTO images (drive_file_id, name, kind, folder_id, captions, created_at, updated_at) VALUES ('vid-a', 'a', 'reel', 'fold-a', '[\"A\"]', ?, ?), ('vid-b', 'b', 'reel', 'fold-b', '[\"B\"]', ?, ?), ('img-1', 'i', 'image', NULL, '[\"I\"]', ?, ?)",
      ).bind(now, now, now, now, now, now),
      env.DB.prepare("INSERT INTO page_times (account_id, minute_of_day, kind) VALUES (1, 600, 'reel'), (2, 900, 'reel'), (1, 300, 'image')"),
    ]);
    await planAutoPosts(getDb(env), now, "UTC");
    const rows = await env.DB.prepare("SELECT p.kind, p.image_key, t.account_id FROM posts p JOIN post_targets t ON t.post_id = p.id").all<Row>();
    for (const r of rows.results) {
      if (r.kind === "image") expect(r.image_key).toBe("img-1");
      else expect(r.image_key).toBe(r.account_id === 1 ? "vid-a" : "vid-b");
    }
    expect(rows.results.some((r) => r.kind === "reel" && r.account_id === 1)).toBe(true);
    expect(rows.results.some((r) => r.kind === "reel" && r.account_id === 2)).toBe(true);
  });

  it("rejects a Reels time less than 10 minutes from an image time, saves folder and times", async () => {
    const bad = await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, times: [600], reelTimes: [605] } });
    expect(bad.status).toBe(400);
    driveWith({ "fold-a": [] });
    const ok = await api("/auto/pages/1", { method: "PUT", json: { autoEnabled: true, times: [600], reelTimes: [720], reelFolder: { id: "fold-a-folder-id", name: "Reels A" } } });
    expect(ok.status).toBe(200);
    const page = ((await (await api("/auto")).json()) as { pages: Row[] }).pages.find((p) => p.id === 1)!;
    expect(page).toMatchObject({ times: [600], reelTimes: [720], reelFolderId: "fold-a-folder-id", reelFolderName: "Reels A" });
  });
});
