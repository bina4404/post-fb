import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { fail } from "../lib/http";

// Giới hạn ảnh của Facebook /photos: PNG tối đa 1MB, JPEG tối đa 4MB.
const MAX_BYTES: Record<string, number> = { "image/jpeg": 4 * 1024 * 1024, "image/png": 1024 * 1024 };

export const mediaRoutes = new Hono<AppEnv>();

mediaRoutes.post("/", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw fail(400, "thiếu file ảnh (field 'file')");
  const max = MAX_BYTES[file.type];
  if (!max) throw fail(400, "chỉ nhận ảnh JPEG hoặc PNG");
  if (file.size > max) throw fail(400, `ảnh quá ${max / 1024 / 1024}MB`);
  const key = crypto.randomUUID();
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  return c.json({ key }, 201);
});

mediaRoutes.get("/:key", async (c) => {
  const key = z.uuid().safeParse(c.req.param("key"));
  if (!key.success) throw fail(404, "không tìm thấy ảnh");
  const object = await c.env.MEDIA.get(key.data);
  if (!object) throw fail(404, "không tìm thấy ảnh");
  return new Response(object.body, {
    headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
  });
});
