import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { images } from "../db/schema";
import type { WorkerEnv } from "../env";
import { driveAccessToken } from "../lib/accounts";
import { log } from "../lib/log";
import { ensureFolder, listImages } from "../platforms/drive";
import { clearFutureAuto } from "./planner";

export type SyncResult = { added: number; disabled: number; total: number };

/**
 * Đồng bộ kho ảnh với thư mục post-fb trên Drive: ảnh mới (kể cả ảnh bạn tự bỏ vào thư mục) vào kho,
 * ảnh đã bị xoá khỏi Drive thì tắt và gỡ các bài tự động chưa đi của nó.
 */
export async function syncDriveImages(db: Db, env: WorkerEnv, now: number): Promise<SyncResult> {
  const token = await driveAccessToken(db, env, now);
  const files = await listImages(token, await ensureFolder(token));

  const known = new Set((await db.select({ id: images.driveFileId }).from(images)).map((r) => r.id));
  const added = files.filter((f) => !known.has(f.id));
  for (let i = 0; i < added.length; i += 50) {
    const rows = added.slice(i, i + 50).map((f) => ({ driveFileId: f.id, name: f.name, createdAt: now, updatedAt: now }));
    await db.insert(images).values(rows).onConflictDoNothing();
  }

  // Drive trả về thư mục rỗng (thư mục bị đổi tên/xoá nên app vừa tạo thư mục mới) thì KHÔNG tắt cả kho ảnh.
  if (files.length === 0) {
    if (known.size) log("warn", "drive_sync_empty_folder", { known: known.size });
    return { added: 0, disabled: 0, total: 0 };
  }
  const gone = await db
    .update(images)
    .set({ enabled: false, updatedAt: now })
    .where(and(eq(images.enabled, true), notInArray(images.driveFileId, files.map((f) => f.id))))
    .returning({ driveFileId: images.driveFileId });
  for (const g of gone) await clearFutureAuto(db, { imageKey: g.driveFileId });
  if (added.length || gone.length) log("info", "drive_sync_done", { added: added.length, disabled: gone.length, total: files.length });
  return { added: added.length, disabled: gone.length, total: files.length };
}
