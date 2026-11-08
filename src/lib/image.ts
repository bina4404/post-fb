import { getDb } from "../db/client";
import type { WorkerEnv } from "../env";
import { downloadFile } from "../platforms/drive";
import { PlatformError, PublishFailure, TIMEOUT_MS } from "../platforms/errors";
import { driveAccessToken } from "./accounts";
import { log } from "./log";

export type Image = { bytes: Uint8Array; contentType: string };

const ALLOWED = new Set(["image/jpeg", "image/png"]);
// Chặn ảnh quá lớn trước khi đọc vào bộ nhớ Worker. Giới hạn riêng của từng nền tảng do nền tảng tự trả lỗi.
const MAX_BYTES = 10 * 1024 * 1024;

/** Đọc body theo từng đoạn và dừng ngay khi vượt `max` byte, để file lớn không chiếm hết bộ nhớ Worker. */
async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body?.getReader();
  for (;;) {
    const part = reader ? await reader.read() : { done: true as const, value: undefined };
    if (part.done) break;
    size += part.value.length;
    if (size > max) {
      await reader!.cancel();
      throw new PublishFailure("permanent", "image_url quá 10MB");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}

async function fromUrl(url: string): Promise<Image> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    log("warn", "image_fetch_failed", { reason: (err as Error).name });
    throw new PublishFailure("transient", "không tải được image_url");
  }
  if (!res.ok) {
    log("warn", "image_fetch_failed", { status: res.status });
    throw new PublishFailure(res.status >= 500 || res.status === 429 ? "transient" : "permanent", `image_url trả về HTTP ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!ALLOWED.has(contentType)) throw new PublishFailure("permanent", `image_url không phải JPEG/PNG (${contentType || "không rõ"})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new PublishFailure("permanent", "image_url quá 10MB");
  const bytes = await readLimited(res.body, MAX_BYTES);
  return { bytes, contentType };
}

async function fromDrive(env: WorkerEnv, fileId: string): Promise<Image> {
  try {
    return await downloadFile(await driveAccessToken(getDb(env), env, Date.now()), fileId);
  } catch (err) {
    // Lỗi token Google không phải lỗi token của Facebook: không được đánh dấu account đích cần kết nối lại.
    if (err instanceof PlatformError && err.kind === "auth") throw new PublishFailure("permanent", "Google Drive cần kết nối lại");
    if (err instanceof PlatformError && err.status === 404) throw new PublishFailure("permanent", "ảnh trên Google Drive không còn");
    throw err;
  }
}

/** Ảnh của bài: từ Google Drive (upload) hoặc tải từ image_url (CSV). Không có ảnh thì trả null. */
export async function loadImage(env: WorkerEnv, post: { imageKey: string | null; imageUrl: string | null }): Promise<Image | null> {
  if (post.imageKey) return fromDrive(env, post.imageKey);
  return post.imageUrl ? fromUrl(post.imageUrl) : null;
}
