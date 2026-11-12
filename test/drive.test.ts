import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { api, count, DRIVE, DRIVE_UPLOAD, seed, seedDrive } from "./helpers";

const PNG = new Uint8Array([137, 80, 78, 71]);
const TOKEN = "POST https://oauth2.googleapis.com/token";
const account = () => env.DB.prepare("SELECT * FROM accounts WHERE id = 3").first<Record<string, string | number>>();

function pngForm(bytes: Uint8Array | string = PNG, type = "image/png") {
  const form = new FormData();
  form.set("file", new File([bytes], "a.png", { type }));
  return form;
}

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());

describe("media on Google Drive", () => {
  /** Drive giả: thư mục post-fb chưa có ở lần đầu, được tạo rồi dùng lại. */
  function driveMock(listed: { id: string; name: string; thumbnailLink?: string }[] = []) {
    let folder: string | null = null;
    return mockFetch({
      [`GET ${DRIVE}/files`]: (req) => {
        const q = new URL(req.url).searchParams.get("q") ?? "";
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) return Response.json({ files: folder ? [{ id: folder }] : [] });
        return Response.json({ files: listed });
      },
      [`POST ${DRIVE}/files`]: () => ((folder = "folder-1"), Response.json({ id: folder })),
      [`POST ${DRIVE_UPLOAD}`]: () => Response.json({ id: "drive-file-123" }),
      [`GET ${DRIVE}/files/drive-file-123`]: () => new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
  }

  it("uploads into the post-fb folder (created once) and serves the file back", async () => {
    await seedDrive();
    const calls = driveMock();
    const res = await api("/media", { method: "POST", body: pngForm() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ key: "drive-file-123" });

    const create = calls.find((r) => r.method === "POST" && !r.url.includes("/upload/"))!;
    expect(await create.json()).toEqual({ name: "post-fb", mimeType: "application/vnd.google-apps.folder" });
    const upload = calls.find((r) => r.url.includes("/upload/"))!;
    expect(new URL(upload.url).searchParams.get("uploadType")).toBe("multipart");
    expect(upload.headers.get("authorization")).toBe("Bearer ya29.ACCESS");
    expect(upload.headers.get("content-type")).toMatch(/^multipart[/]related; boundary=/);
    const text = new TextDecoder().decode(new Uint8Array(await upload.arrayBuffer()));
    expect(text).toContain('"parents":["folder-1"]');
    expect(text).toMatch(/"name":"a-[0-9a-f]{8}[.]png"/);
    expect(text).toContain("Content-Type: image/png");

    calls.length = 0;
    expect((await api("/media", { method: "POST", body: pngForm() })).status).toBe(201);
    expect(calls.filter((r) => r.method === "POST" && !r.url.includes("/upload/"))).toHaveLength(0); // thư mục được dùng lại

    const get = await api("/media/drive-file-123");
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);
  });

  it("lists images in the post-fb folder, newest first", async () => {
    await seedDrive();
    const images = [{ id: "img-2-xxxxxxxx", name: "b.png", thumbnailLink: "https://lh3.test/b" }, { id: "img-1-xxxxxxxx", name: "a.jpg" }];
    const calls = driveMock(images);
    await api("/media", { method: "POST", body: pngForm() }); // tạo thư mục
    const res = await api("/media");
    expect(await res.json()).toEqual(images);
    const list = new URL(calls.at(-1)!.url).searchParams;
    expect(list.get("q")).toBe("'folder-1' in parents and trashed = false and mimeType contains 'image/'");
    expect(list.get("orderBy")).toBe("createdTime desc");
  });

  it("asks to connect Google Drive when no account is connected", async () => {
    mockFetch({});
    const res = await api("/media", { method: "POST", body: pngForm() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("chưa kết nối Google Drive");
    expect((await api("/media")).status).toBe(400);
  });

  it("still validates type and size before calling Drive", async () => {
    await seedDrive();
    const calls = mockFetch({});
    expect((await api("/media", { method: "POST", body: pngForm("x", "image/gif") })).status).toBe(400);
    expect((await api("/media", { method: "POST", body: pngForm(new Uint8Array(1024 * 1024 + 1)) })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed file id", async () => {
    expect((await api("/media/..%2Fetc")).status).toBe(404);
  });

  it("keeps the Drive image when the post is deleted, so it can be reused", async () => {
    await seedDrive();
    const calls = mockFetch({});
    const post = (await (await api("/posts", { method: "POST", json: { caption: "x", facebookAccountIds: [1], imageKey: "drive-file-123" } })).json()) as { id: number };
    expect((await api(`/posts/${post.id}`, { method: "DELETE" })).status).toBe(204);
    expect(calls).toHaveLength(0);
    expect(await count("posts")).toBe(0);
  });
});

describe("Google access token", () => {
  it("refreshes an expired access token and stores it encrypted", async () => {
    await seedDrive(30_000); // hết hạn trong < 1 phút
    const calls = mockFetch({
      [TOKEN]: () => Response.json({ access_token: "ya29.NEW", expires_in: 3599 }),
      [`GET ${DRIVE}/files/drive-file-123`]: () => new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    expect((await api("/media/drive-file-123")).status).toBe(200);
    expect(Object.fromEntries(await calls[0]!.formData())).toEqual({
      client_id: "g-client",
      client_secret: "g-secret",
      grant_type: "refresh_token",
      refresh_token: "1//REFRESH",
    });
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer ya29.NEW");
    const row = await account();
    expect(await decryptToken(String(row!.access_token_enc), env.TOKEN_ENC_KEY)).toBe("ya29.NEW");
    expect(await decryptToken(String(row!.refresh_token_enc), env.TOKEN_ENC_KEY)).toBe("1//REFRESH");
  });

  it("marks Google needs_reauth when the refresh token is revoked", async () => {
    await seedDrive(0);
    mockFetch({ [TOKEN]: () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    expect((await api("/media/drive-file-123")).status).toBe(400);
    expect((await account())!.status).toBe("needs_reauth");
  });
});

describe("Google OAuth", () => {
  it("asks for offline drive.file access and stores the account by email", async () => {
    const start = await api("/oauth/google/start");
    const location = new URL(start.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly",
      access_type: "offline",
      prompt: "consent",
      redirect_uri: "http://localhost/api/oauth/google/callback",
    });

    mockFetch({
      [TOKEN]: () => Response.json({ access_token: "ya29.A", refresh_token: "1//R", expires_in: 3599 }),
      [`GET ${DRIVE}/about`]: () => Response.json({ user: { emailAddress: "me@gmail.com" } }),
    });
    const res = await api(`/oauth/google/callback?state=${location.searchParams.get("state")}&code=gcode`);
    expect(res.headers.get("location")).toBe("/#/accounts");
    const row = await env.DB.prepare("SELECT * FROM accounts WHERE platform = 'google'").first<Record<string, string | number>>();
    expect(row).toMatchObject({ name: "me@gmail.com", status: "ok" });
    expect(await decryptToken(String(row!.refresh_token_enc), env.TOKEN_ENC_KEY)).toBe("1//R");
  });
});

describe("library thumbnails", () => {
  it("serves Drive's small thumbnail instead of the full image", async () => {
    await seedDrive();
    const calls = mockFetch({
      [`GET ${DRIVE}/files/drive-file-123`]: () => Response.json({ thumbnailLink: "https://lh3.test/thumb=s220" }),
      "GET https://lh3.test/thumb=s220": () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } }),
    });
    const res = await api("/media/drive-file-123?thumb=1");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(new URL(calls[0]!.url).searchParams.get("fields")).toBe("thumbnailLink");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer ya29.ACCESS");
  });
});

describe("sync the image library with the Drive folder", () => {
  /** Drive giả: thư mục post-fb đã có, nội dung thư mục đổi theo `files`. */
  function folderWith(files: { id: string; name: string }[]) {
    return mockFetch({
      [`GET ${DRIVE}/files`]: (req) => {
        const q = new URL(req.url).searchParams.get("q") ?? "";
        return Response.json({ files: q.includes("vnd.google-apps.folder") ? [{ id: "folder-1" }] : files });
      },
    });
  }
  const rows = async () =>
    (await env.DB.prepare("SELECT drive_file_id AS id, enabled FROM images ORDER BY drive_file_id").all<{ id: string; enabled: number }>()).results;

  it("adds images you put in the folder yourself, and disables ones removed from Drive", async () => {
    await seedDrive();
    folderWith([{ id: "manual-photo-1", name: "a.jpg" }, { id: "manual-photo-2", name: "b.png" }]);
    expect(await (await api("/images/sync", { method: "POST" })).json()).toEqual({ added: 2, disabled: 0, total: 2 });
    expect(await rows()).toEqual([{ id: "manual-photo-1", enabled: 1 }, { id: "manual-photo-2", enabled: 1 }]);

    vi.restoreAllMocks();
    folderWith([{ id: "manual-photo-1", name: "a.jpg" }]);
    expect(await (await api("/images/sync", { method: "POST" })).json()).toEqual({ added: 0, disabled: 1, total: 1 });
    expect(await rows()).toEqual([{ id: "manual-photo-1", enabled: 1 }, { id: "manual-photo-2", enabled: 0 }]);
  });

  it("never disables the whole library when the folder comes back empty", async () => {
    await seedDrive();
    folderWith([{ id: "manual-photo-1", name: "a.jpg" }]);
    await api("/images/sync", { method: "POST" });
    vi.restoreAllMocks();
    folderWith([]);
    expect(await (await api("/images/sync", { method: "POST" })).json()).toEqual({ added: 0, disabled: 0, total: 0 });
    expect(await rows()).toEqual([{ id: "manual-photo-1", enabled: 1 }]);
  });
});
