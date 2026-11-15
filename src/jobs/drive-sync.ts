import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, images } from "../db/schema";
import type { WorkerEnv } from "../env";
import { driveAccessToken } from "../lib/accounts";
import { log } from "../lib/log";
import { ensureFolder, listImages, type DriveImage } from "../platforms/drive";
import { clearFutureAuto } from "./planner";

export type SyncResult = { added: number; disabled: number; total: number };

// D1 cho phép tối đa 100 tham số mỗi câu SQL: chia nhỏ (Drizzle gửi tới 8 tham số cho mỗi dòng mới, kể cả cột mặc định).
const INSERT_CHUNK = 12;
const ID_CHUNK = 90;
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * Đồng bộ kho ảnh với thư mục post-fb trên Drive: ảnh mới (kể cả ảnh bạn tự bỏ vào thư mục) vào kho,
 * ảnh đã bị xoá khỏi Drive thì tắt và gỡ các bài tự động chưa đi của nó.
 */
export async function syncDriveImages(db: Db, env: WorkerEnv, now: number): Promise<SyncResult> {
  const token = await driveAccessToken(db, env, now);
  const files = await listImages(token, await ensureFolder(token));
  const existing = await db.select({ id: images.driveFileId, enabled: images.enabled }).from(images).where(eq(images.kind, "image"));

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

/** Reels của Facebook dài 3–90 giây. Drive chưa xử lý xong video (chưa có thời lượng) thì vẫn nhận, Facebook sẽ tự kiểm tra. */
const REEL_MIN_MS = 3_000;
const REEL_MAX_MS = 90_000;
const fitsReel = (f: DriveImage) => {
  const ms = Number(f.videoMediaMetadata?.durationMillis ?? 0);
  return !ms || (ms >= REEL_MIN_MS && ms <= REEL_MAX_MS);
};

export type VideoSyncResult = SyncResult & { skipped: number };

/** Thư mục video Reels đang được ít nhất một Page dùng. */
async function reelFolders(db: Db): Promise<string[]> {
  const rows = await db.select({ id: accounts.reelFolderId }).from(accounts).where(and(eq(accounts.platform, "facebook"), isNotNull(accounts.reelFolderId)));
  return [...new Set(rows.map((r) => r.id!))];
}

/**
 * Đồng bộ kho video Reels với các thư mục Drive mà các Page đã chọn: video mới vào kho (kind=reel, nhớ thư mục),
 * video chuyển thư mục thì cập nhật, video bị xoá khỏi thư mục thì tắt và gỡ các bài tự động chưa đi của nó.
 * Video dài quá 90 giây hoặc ngắn dưới 3 giây không vào kho (skipped).
 */
export async function syncReelVideos(db: Db, env: WorkerEnv, now: number): Promise<VideoSyncResult> {
  const folders = await reelFolders(db);
  if (folders.length === 0) return { added: 0, disabled: 0, total: 0, skipped: 0 };
  const token = await driveAccessToken(db, env, now);
  const listed = await Promise.all(folders.map(async (folderId) => ({ folderId, files: await listImages(token, folderId, "video/") })));
  const existing = await db.select({ id: images.driveFileId, enabled: images.enabled, folderId: images.folderId }).from(images).where(eq(images.kind, "reel"));
  const known = new Map(existing.map((r) => [r.id, r]));

  let added = 0;
  let skipped = 0;
  const onDrive = new Set<string>();
  for (const { folderId, files } of listed) {
    const usable = files.filter(fitsReel);
    skipped += files.length - usable.length;
    usable.forEach((f) => onDrive.add(f.id));
    const fresh = usable.filter((f) => !known.has(f.id));
    added += fresh.length;
    for (const part of chunks(fresh, INSERT_CHUNK)) {
      await db.insert(images).values(part.map((f) => ({ driveFileId: f.id, name: f.name, kind: "reel" as const, folderId, createdAt: now, updatedAt: now }))).onConflictDoNothing();
    }
    const moved = usable.filter((f) => known.has(f.id) && known.get(f.id)!.folderId !== folderId).map((f) => f.id);
    for (const part of chunks(moved, ID_CHUNK)) await db.update(images).set({ folderId, updatedAt: now }).where(inArray(images.driveFileId, part));
  }

  // Thư mục trả về rỗng (bị đổi tên/xoá, hoặc Drive lỗi tạm) thì không tắt video của nó.
  const checked = new Set(listed.filter((l) => l.files.length > 0).map((l) => l.folderId));
  const gone = existing.filter((r) => r.enabled && r.folderId && checked.has(r.folderId) && !onDrive.has(r.id)).map((r) => r.id);
  for (const part of chunks(gone, ID_CHUNK)) await db.update(images).set({ enabled: false, updatedAt: now }).where(inArray(images.driveFileId, part));
  for (const imageKey of gone) await clearFutureAuto(db, { imageKey });
  const total = onDrive.size;
  if (added || gone.length || skipped) log("info", "reel_sync_done", { folders: folders.length, added, disabled: gone.length, skipped, total });
  return { added, disabled: gone.length, total, skipped };
}
