import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { images } from "../db/schema";
import type { WorkerEnv } from "../env";
import { driveAccessToken } from "../lib/accounts";
import { log } from "../lib/log";
import { ensureFolder, listImages } from "../platforms/drive";
import { clearFutureAuto } from "./planner";

export type SyncResult = { added: number; disabled: number; total: number };

// D1 cho phép tối đa 100 tham số mỗi câu SQL: chia nhỏ (Drizzle gửi 6 tham số cho mỗi ảnh mới, kể cả cột mặc định).
const INSERT_CHUNK = 15;
const ID_CHUNK = 90;
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * Đồng bộ kho ảnh với thư mục post-fb trên Drive: ảnh mới (kể cả ảnh bạn tự bỏ vào thư mục) vào kho,
 * ảnh đã bị xoá khỏi Drive thì tắt và gỡ các bài tự động chưa đi của nó.
 */
export async function syncDriveImages(db: Db, env: WorkerEnv, now: number): Promise<SyncResult> {
  const token = await driveAccessToken(db, env, now);
  const files = await listImages(token, await ensureFolder(token));
  const existing = await db.select({ id: images.driveFileId, enabled: images.enabled }).from(images);

  const known = new Set(existing.map((r) => r.id));
  const added = files.filter((f) => !known.has(f.id));
  for (const part of chunks(added, INSERT_CHUNK)) {
    await db.insert(images).values(part.map((f) => ({ driveFileId: f.id, name: f.name, createdAt: now, updatedAt: now }))).onConflictDoNothing();
  }

  // Drive trả về thư mục rỗng (thư mục bị đổi tên/xoá nên app vừa tạo thư mục mới) thì KHÔNG tắt cả kho ảnh.
  if (files.length === 0) {
    if (known.size) log("warn", "drive_sync_empty_folder", { known: known.size });
    return { added: 0, disabled: 0, total: 0 };
  }
  const onDrive = new Set(files.map((f) => f.id));
  const gone = existing.filter((r) => r.enabled && !onDrive.has(r.id)).map((r) => r.id);
  for (const part of chunks(gone, ID_CHUNK)) {
    await db.update(images).set({ enabled: false, updatedAt: now }).where(inArray(images.driveFileId, part));
  }
  for (const imageKey of gone) await clearFutureAuto(db, { imageKey });
  if (added.length || gone.length) log("info", "drive_sync_done", { added: added.length, disabled: gone.length, total: files.length });
  return { added: added.length, disabled: gone.length, total: files.length };
}
