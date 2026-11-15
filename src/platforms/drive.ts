// Adapter duy nhất gọi Google OAuth + Drive API v3. Tài liệu: developers.google.com/identity/protocols/oauth2/web-server,
// developers.google.com/drive/api/guides/manage-uploads
import { z } from "zod";
import type { WorkerEnv } from "../env";
import { fetchWithTimeout, platformError, VIDEO_TIMEOUT_MS, type ErrorKind } from "./errors";

export type GoogleConfig = { clientId: string; clientSecret: string };
export type GoogleTokens = { accessToken: string; refreshToken: string | null; accessExpiresAt: number };
export type DriveFile = { bytes: Uint8Array; contentType: string };

export const googleConfig = (env: WorkerEnv): GoogleConfig => ({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
});

// drive.file: tạo thư mục và upload ảnh. drive.readonly: đọc được cả ảnh bạn tự bỏ vào thư mục post-fb trên Drive
// (quyền hạn chế của Google: app chưa xác minh sẽ hiện cảnh báo khi kết nối, vẫn bấm tiếp tục được).
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";
export const driveFileId = z.string().regex(/^[\w-]{10,200}$/);

const DRIVE = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function classify(status: number, error?: string): ErrorKind {
  if (status === 401 || error === "invalid_grant") return "auth";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

async function call(op: string, url: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const res = await fetchWithTimeout("google", op, url, init, timeoutMs);
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

const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_FOLDER = "post-fb";

const listUrl = (q: string, fields: string, extra: Record<string, string> = {}) =>
  `${DRIVE}/files?${new URLSearchParams({ q, fields, ...extra })}`;

/**
 * Id thư mục "post-fb" trong My Drive, tạo mới nếu chưa có. Với scope drive.file app chỉ thấy thư mục do chính nó tạo.
 * shortcut: hai lần upload đầu tiên chạy song song có thể tạo 2 thư mục cùng tên; lần sau luôn dùng thư mục tìm thấy đầu tiên.
 */
export async function ensureFolder(token: string): Promise<string> {
  const q = `name = '${DRIVE_FOLDER}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = await call("find_folder", listUrl(q, "files(id)", { pageSize: "1", orderBy: "createdTime" }), { headers: bearer(token) });
  const [folder] = ((await found.json()) as { files: { id: string }[] }).files;
  if (folder) return folder.id;
  const res = await call("create_folder", `${DRIVE}/files?fields=id`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: FOLDER_MIME }),
  });
  return ((await res.json()) as { id: string }).id;
}

export type DriveImage = { id: string; name: string; thumbnailLink?: string; createdTime: string; videoMediaMetadata?: { durationMillis?: string } };

/** Đọc hết các trang kết quả của một truy vấn files.list (1000 file mỗi trang). */
async function listAll<T>(op: string, q: string, fields: string, token: string, orderBy: string): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | undefined;
  do {
    const extra: Record<string, string> = { orderBy, pageSize: "1000", ...(pageToken ? { pageToken } : {}) };
    const res = await call(op, listUrl(q, `nextPageToken,files(${fields})`, extra), { headers: bearer(token) });
    const page = (await res.json()) as { files: T[]; nextPageToken?: string };
    all.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

/** Mọi ảnh (hoặc video) trong một thư mục, mới nhất trước. */
export function listImages(token: string, folderId: string, mime: "image/" | "video/" = "image/"): Promise<DriveImage[]> {
  const q = `'${folderId}' in parents and trashed = false and mimeType contains '${mime}'`;
  const fields = mime === "video/" ? "id,name,thumbnailLink,createdTime,videoMediaMetadata(durationMillis)" : "id,name,thumbnailLink,createdTime";
  return listAll(mime === "video/" ? "list_videos" : "list_images", q, fields, token, "createdTime desc");
}

/** Mọi thư mục trên Drive của tài khoản (để chọn thư mục video Reels cho từng Page), theo tên. */
export function listFolders(token: string): Promise<{ id: string; name: string }[]> {
  return listAll("list_folders", `mimeType = '${FOLDER_MIME}' and trashed = false`, "id,name", token, "name");
}

export type VideoStream = { body: ReadableStream<Uint8Array>; size: number };

/** Mở video để đẩy thẳng sang Facebook theo luồng: không đọc cả file vào bộ nhớ Worker. */
export async function openVideo(token: string, fileId: string): Promise<VideoStream> {
  const res = await call("download_video", `${DRIVE}/files/${fileId}?alt=media`, { headers: bearer(token) }, VIDEO_TIMEOUT_MS);
  const size = Number(res.headers.get("content-length"));
  if (!res.body || !size) throw platformError("google", "download_video", "transient", res.status, null, "Drive không trả kích thước video");
  return { body: res.body, size };
}

/** Upload kiểu multipart/related (metadata + nội dung trong một request) vào thư mục `folderId`. Trả về id của file. */
export async function uploadFile(token: string, folderId: string, name: string, file: DriveFile): Promise<string> {
  const boundary = `post-fb-${crypto.randomUUID()}`;
  const CRLF = "\r\n";
  const body = new Blob([
    `--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${JSON.stringify({ name, parents: [folderId] })}${CRLF}`,
    `--${boundary}${CRLF}Content-Type: ${file.contentType}${CRLF}${CRLF}`,
    file.bytes,
    `${CRLF}--${boundary}--`,
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

/** Ảnh nhỏ (khoảng 220px) do Drive tạo sẵn, để hiện trong danh sách. Drive chưa có ảnh nhỏ thì trả file gốc. */
export async function downloadThumbnail(token: string, fileId: string): Promise<DriveFile> {
  const meta = await call("thumbnail_link", `${DRIVE}/files/${fileId}?fields=thumbnailLink,mimeType`, { headers: bearer(token) });
  const { thumbnailLink, mimeType } = (await meta.json()) as { thumbnailLink?: string; mimeType?: string };
  // Video chưa có ảnh nhỏ (Drive đang xử lý): không tải cả video về chỉ để làm ảnh xem trước.
  if (!thumbnailLink && mimeType?.startsWith("video/")) throw platformError("google", "thumbnail", "permanent", 404, null, "video chưa có ảnh xem trước");
  if (!thumbnailLink) return downloadFile(token, fileId);
  const res = await call("thumbnail", thumbnailLink, { headers: bearer(token) });
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/jpeg" };
}
