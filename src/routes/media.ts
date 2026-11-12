import { Hono } from "hono";
import { getDb } from "../db/client";
import { images } from "../db/schema";
import type { AppEnv } from "../env";
import { driveAccessToken } from "../lib/accounts";
import { fail } from "../lib/http";
import { downloadFile, downloadThumbnail, driveFileId, ensureFolder, listImages, uploadFile } from "../platforms/drive";
import { PublishFailure } from "../platforms/errors";

// Giới hạn ảnh của Facebook /photos: PNG tối đa 1MB, JPEG tối đa 4MB.
const MAX_BYTES: Record<string, number> = { "image/jpeg": 4 * 1024 * 1024, "image/png": 1024 * 1024 };

/** Lỗi Drive (chưa kết nối, token hỏng, Drive lỗi) trả về cho người dùng thay vì 500. */
async function viaDrive<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PublishFailure) throw fail(400, `Google Drive: ${err.message}`);
    throw err;
  }
}

export const mediaRoutes = new Hono<AppEnv>();

mediaRoutes.post("/", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw fail(400, "thiếu file ảnh (field 'file')");
  const max = MAX_BYTES[file.type];
  if (!max) throw fail(400, "chỉ nhận ảnh JPEG hoặc PNG");
  if (file.size > max) throw fail(400, `ảnh quá ${max / 1024 / 1024}MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const key = await viaDrive(async () => {
    const token = await driveAccessToken(getDb(c.env), c.env, Date.now());
    const ext = file.type === "image/png" ? "png" : "jpg";
    const name = `${file.name.replace(/[.][^.]*$/, "") || "image"}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const id = await uploadFile(token, await ensureFolder(token), name, { bytes, contentType: file.type });
    const now = Date.now();
    await getDb(c.env).insert(images).values({ driveFileId: id, name, createdAt: now, updatedAt: now }).onConflictDoNothing();
    return id;
  });
  return c.json({ key }, 201);
});

// Ảnh trong thư mục post-fb trên Google Drive, để chọn lại cho bài mới.
mediaRoutes.get("/", async (c) => {
  const images = await viaDrive(async () => {
    const token = await driveAccessToken(getDb(c.env), c.env, Date.now());
    return listImages(token, await ensureFolder(token));
  });
  return c.json(images);
});

// Xem trước ảnh trong UI: Worker đọc từ Drive rồi trả lại, file trên Drive không cần chia sẻ công khai.
// ?thumb=1: chỉ lấy ảnh nhỏ cho danh sách, không tải file gốc (tối đa 4MB) cho từng ô.
mediaRoutes.get("/:key", async (c) => {
  const key = driveFileId.safeParse(c.req.param("key"));
  if (!key.success) throw fail(404, "không tìm thấy ảnh");
  const read = c.req.query("thumb") ? downloadThumbnail : downloadFile;
  const file = await viaDrive(async () => read(await driveAccessToken(getDb(c.env), c.env, Date.now()), key.data));
  return new Response(file.bytes, { headers: { "content-type": file.contentType, "cache-control": "private, max-age=3600" } });
});
