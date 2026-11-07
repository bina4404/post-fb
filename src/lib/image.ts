import type { WorkerEnv } from "../env";
import { PublishFailure, TIMEOUT_MS } from "../platforms/errors";
import { log } from "./log";

export type Image = { bytes: Uint8Array; contentType: string };

const ALLOWED = new Set(["image/jpeg", "image/png"]);
// Chặn ảnh quá lớn trước khi đọc vào bộ nhớ Worker. Giới hạn riêng của từng nền tảng do nền tảng tự trả lỗi.
const MAX_BYTES = 10 * 1024 * 1024;

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
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new PublishFailure("permanent", "image_url quá 10MB");
  return { bytes, contentType };
}

/** Ảnh của bài: từ R2 (upload) hoặc tải từ image_url (CSV). Không có ảnh thì trả null. */
export async function loadImage(env: WorkerEnv, post: { imageKey: string | null; imageUrl: string | null }): Promise<Image | null> {
  if (post.imageKey) {
    const object = await env.MEDIA.get(post.imageKey);
    if (!object) throw new PublishFailure("permanent", "ảnh trong R2 không còn");
    return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? "image/jpeg" };
  }
  return post.imageUrl ? fromUrl(post.imageUrl) : null;
}
