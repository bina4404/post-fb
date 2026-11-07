// Adapter duy nhất gọi Google OAuth + Drive API v3. Tài liệu: developers.google.com/identity/protocols/oauth2/web-server,
// developers.google.com/drive/api/guides/manage-uploads
import { z } from "zod";
import type { WorkerEnv } from "../env";
import { fetchWithTimeout, platformError, type ErrorKind } from "./errors";

export type GoogleConfig = { clientId: string; clientSecret: string };
export type GoogleTokens = { accessToken: string; refreshToken: string | null; accessExpiresAt: number };
export type DriveFile = { bytes: Uint8Array; contentType: string };

export const googleConfig = (env: WorkerEnv): GoogleConfig => ({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
});

// drive.file: app chỉ thấy file do chính nó tạo. Scope không nhạy cảm, không cần Google xét duyệt.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const driveFileId = z.string().regex(/^[\w-]{10,200}$/);

const DRIVE = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function classify(status: number, error?: string): ErrorKind {
  if (status === 401 || error === "invalid_grant") return "auth";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

async function call(op: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchWithTimeout("google", op, url, init);
  if (res.ok) return res;
  const body = (await res.json().catch(() => ({}))) as { error?: string | { message?: string }; error_description?: string };
  const code = typeof body.error === "string" ? body.error : null;
  const message = body.error_description ?? (typeof body.error === "object" ? body.error.message : undefined) ?? `HTTP ${res.status}`;
  throw platformError("google", op, classify(res.status, code ?? undefined), res.status, code, message);
}

export function authorizeUrl(cfg: GoogleConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline", // để có refresh token
    prompt: "consent", // Google chỉ trả refresh token ở lần đồng ý; ép đồng ý lại để kết nối lại vẫn có
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(cfg: GoogleConfig, op: string, form: Record<string, string>, now: number): Promise<GoogleTokens> {
  const res = await call(op, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }),
  });
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, accessExpiresAt: now + t.expires_in * 1000 };
}

export const exchangeCode = (cfg: GoogleConfig, redirectUri: string, code: string, now: number) =>
  tokenRequest(cfg, "exchange_code", { grant_type: "authorization_code", code, redirect_uri: redirectUri }, now);

export const refreshAccessToken = (cfg: GoogleConfig, refreshToken: string, now: number) =>
  tokenRequest(cfg, "refresh_token", { grant_type: "refresh_token", refresh_token: refreshToken }, now);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function getEmail(token: string): Promise<string> {
  const res = await call("about", `${DRIVE}/about?fields=user(emailAddress)`, { headers: bearer(token) });
  return ((await res.json()) as { user: { emailAddress: string } }).user.emailAddress;
}

/** Upload kiểu multipart/related (metadata + nội dung trong một request). Trả về id của file. */
export async function uploadFile(token: string, name: string, file: DriveFile): Promise<string> {
  const boundary = `post-fb-${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    file.bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await call("upload", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { ...bearer(token), "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return ((await res.json()) as { id: string }).id;
}

export async function downloadFile(token: string, fileId: string): Promise<DriveFile> {
  const res = await call("download", `${DRIVE}/files/${fileId}?alt=media`, { headers: bearer(token) });
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

export async function deleteFile(token: string, fileId: string): Promise<void> {
  await call("delete", `${DRIVE}/files/${fileId}`, { method: "DELETE", headers: bearer(token) });
}
