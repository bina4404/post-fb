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
  it("uploads with multipart/related and serves the file back through the Worker", async () => {
    await seedDrive();
    const calls = mockFetch({
      [`POST ${DRIVE_UPLOAD}`]: () => Response.json({ id: "drive-file-123" }),
      [`GET ${DRIVE}/files/drive-file-123`]: () => new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    const res = await api("/media", { method: "POST", body: pngForm() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ key: "drive-file-123" });

    const upload = calls[0]!;
    expect(new URL(upload.url).searchParams.get("uploadType")).toBe("multipart");
    expect(upload.headers.get("authorization")).toBe("Bearer ya29.ACCESS");
    expect(upload.headers.get("content-type")).toMatch(/^multipart\/related; boundary=/);
    const body = new Uint8Array(await upload.arrayBuffer());
    const text = new TextDecoder().decode(body);
    expect(text).toMatch(/"name":"post-fb-[0-9a-f-]+\.png"/);
    expect(text).toContain("Content-Type: image/png");

    const get = await api("/media/drive-file-123");
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);
  });

  it("asks to connect Google Drive when no account is connected", async () => {
    mockFetch({});
    const res = await api("/media", { method: "POST", body: pngForm() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("chưa kết nối Google Drive");
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

  it("deletes the Drive file with the post, and a Drive failure does not block deletion", async () => {
    await seedDrive();
    const calls = mockFetch({ [`DELETE ${DRIVE}/files/drive-file-123`]: () => new Response(null, { status: 204 }) });
    const post = (await (await api("/posts", { method: "POST", json: { caption: "x", facebookAccountId: 1, imageKey: "drive-file-123" } })).json()) as { id: number };
    expect((await api(`/posts/${post.id}`, { method: "DELETE" })).status).toBe(204);
    expect(calls.map((r) => r.method)).toEqual(["DELETE"]);

    vi.restoreAllMocks();
    mockFetch({ [`DELETE ${DRIVE}/files/drive-file-456`]: () => Response.json({ error: { message: "boom" } }, { status: 500 }) });
    const other = (await (await api("/posts", { method: "POST", json: { caption: "x", facebookAccountId: 1, imageKey: "drive-file-456" } })).json()) as { id: number };
    expect((await api(`/posts/${other.id}`, { method: "DELETE" })).status).toBe(204);
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
      scope: "https://www.googleapis.com/auth/drive.file",
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
