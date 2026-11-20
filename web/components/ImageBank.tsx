import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api } from "../api";
import { formatTime, useTz } from "../time";
import { Button, ErrorText } from "./ui";

export type BankImage = {
  id: number;
  driveFileId: string;
  name: string;
  kind: "image" | "reel";
  folderId: string | null;
  captions: string[];
  enabled: boolean;
  lastUsedAt: number | null;
  nextUseAt: number | null;
};
const MAX_CAPTIONS = 10;
const ACCEPTED = ["image/jpeg", "image/png"];
type Filter = "all" | "missing" | "off";

function ImageCard({ image, onChanged }: { image: BankImage; onChanged: (message?: string) => void }) {
  const tz = useTz();
  const [captions, setCaptions] = useState(() => Array.from({ length: MAX_CAPTIONS }, (_, i) => image.captions[i] ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = image.captions.length;

  async function save(body: { captions?: string[]; enabled?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ plan: { created: number; shortages: number } }>(`/images/${image.id}`, { method: "PATCH", json: body });
      onChanged(r.plan.created ? `Đã lên lịch thêm ${r.plan.created} bài tự động.` : undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`space-y-2 rounded border bg-white p-2 text-sm ${image.enabled ? "" : "opacity-60"}`}>
      <div className="flex gap-2">
        <img src={`/api/media/${image.driveFileId}?thumb=1`} alt={image.name} loading="lazy" className="h-20 w-20 shrink-0 rounded object-cover" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium" title={image.name}>{image.name}</p>
          <p className={filled ? "text-gray-600" : "font-medium text-amber-700"}>{filled}/{MAX_CAPTIONS} caption{filled ? "" : " (chưa dùng được)"}</p>
          <p className="text-xs text-gray-500">
            {image.lastUsedAt ? `Đăng gần nhất: ${formatTime(image.lastUsedAt, tz)}` : "Chưa đăng lần nào"}
            {image.nextUseAt ? ` · Sắp đăng: ${formatTime(image.nextUseAt, tz)}` : ""}
          </p>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={image.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} /> Dùng cho đăng tự động
          </label>
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-blue-700">Sửa caption</summary>
        <div className="mt-2 space-y-1">
          {captions.map((text, i) => (
            <textarea
              key={i}
              rows={2}
              aria-label={`Caption ${i + 1}`}
              placeholder={`Caption ${i + 1}`}
              className="w-full rounded border border-gray-300 px-2 py-1"
              value={text}
              onChange={(e) => setCaptions(captions.map((c, j) => (j === i ? e.target.value : c)))}
            />
          ))}
          <Button variant="primary" disabled={busy} onClick={() => save({ captions })}>Lưu caption</Button>
        </div>
      </details>
      <ErrorText error={error} />
    </li>
  );
}

function Uploader({ onDone }: { onDone: (message: string) => void }) {
  const [progress, setProgress] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function upload(files: File[]) {
    const ok = files.filter((f) => ACCEPTED.includes(f.type));
    const failed: string[] = files.filter((f) => !ACCEPTED.includes(f.type)).map((f) => `${f.name} (không phải JPEG/PNG)`);
    for (const [i, file] of ok.entries()) {
      setProgress(`Đang tải ${i + 1}/${ok.length}: ${file.name}`);
      const form = new FormData();
      form.set("file", file);
      // Tải lần lượt từng ảnh: nhẹ cho Worker và Drive, lỗi một ảnh không làm hỏng cả lượt.
      await api("/media", { method: "POST", body: form }).catch((e: Error) => failed.push(`${file.name} (${e.message})`));
    }
    setProgress(null);
    onDone(`Đã tải lên ${ok.length - failed.filter((f) => !f.includes("không phải")).length} ảnh.${failed.length ? ` Lỗi: ${failed.join("; ")}` : ""} Nhớ thêm caption cho ảnh mới.`);
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => (e.preventDefault(), setDragging(false), void upload([...e.dataTransfer.files]));

  return (
    <div
      onDragOver={(e) => (e.preventDefault(), setDragging(true))}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`flex flex-wrap items-center gap-3 rounded border-2 border-dashed p-4 text-sm ${dragging ? "border-blue-600 bg-blue-50" : "border-gray-300"}`}
    >
      <label className="cursor-pointer rounded border border-gray-300 bg-white px-3 py-1.5 font-medium hover:bg-gray-100">
        Chọn nhiều ảnh
        <input type="file" multiple accept={ACCEPTED.join(",")} className="sr-only" onChange={(e) => void upload([...(e.target.files ?? [])])} />
      </label>
      <span className="text-gray-500">{progress ?? "hoặc kéo thả nhiều ảnh vào đây (JPEG ≤4MB, PNG ≤1MB). Bạn cũng có thể bỏ ảnh thẳng vào thư mục post-fb trên Google Drive: app tự đồng bộ mỗi giờ, hoặc bấm Đồng bộ từ Drive."}</span>
    </div>
  );
}

export type FolderInfo = { name: string; pages: string[] };
type BankProps = { kind: "image" | "reel"; folders?: Map<string, FolderInfo>; onChanged: () => void };

/** Kho ảnh (thư mục post-fb) hoặc kho video Reels (thư mục video của các Page). */
export function ImageBank({ kind, folders, onChanged }: BankProps) {
  const reels = kind === "reel";
  const noun = reels ? "video" : "ảnh";
  const [list, setList] = useState<BankImage[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => api<BankImage[]>("/images").then(setList, (e: Error) => setMessage(e.message)), []);
  useEffect(() => void load(), [load]);
  const changed = (m?: string) => (m && setMessage(m), load(), onChanged());

  async function sync() {
    try {
      const r = await api<{ added: number; disabled: number; total: number; skipped?: number }>(`/images/sync${reels ? "?kind=reel" : ""}`, { method: "POST" });
      const skipped = r.skipped ? ` Bỏ qua ${r.skipped} video không dài 3–90 giây.` : "";
      changed(`Drive có ${r.total} ${noun}: thêm ${r.added} ${noun} mới, tắt ${r.disabled} ${noun} không còn trên Drive.${skipped}`);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  const mine = (list ?? []).filter((i) => (i.kind ?? "image") === kind);
  const shown = mine.filter((i) => (filter === "missing" ? i.enabled && i.captions.length === 0 : filter === "off" ? !i.enabled : true));
  const missing = mine.filter((i) => i.enabled && i.captions.length === 0).length;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{reels ? "Kho video Reels" : "Kho ảnh"} ({list ? mine.length : "…"} {noun})</h2>
        <Button onClick={sync} title={reels ? "Đọc lại thư mục video của các Page trên Drive (app cũng tự đồng bộ mỗi giờ)" : "Đọc lại thư mục post-fb trên Drive (app cũng tự đồng bộ mỗi giờ)"}>
          Đồng bộ từ Drive
        </Button>
      </div>
      {reels ? (
        <p className="text-sm text-gray-500">Bỏ video vào thư mục đã chọn cho Page trên Google Drive, rồi bấm Đồng bộ từ Drive (app cũng tự đồng bộ mỗi giờ). Nhớ thêm caption cho video mới.</p>
      ) : (
        <Uploader onDone={(m) => changed(m)} />
      )}
      {message && <p role="status" className="rounded bg-gray-100 p-2 text-sm">{message} <button className="ml-2 text-blue-700 underline" onClick={() => setMessage(null)}>Đóng</button></p>}
      <div className="flex gap-3 text-sm">
        {(["all", "missing", "off"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={filter === f ? "font-semibold text-blue-700" : "text-gray-600"}>
            {f === "all" ? "Tất cả" : f === "missing" ? `Thiếu caption (${missing})` : "Đang tắt"}
          </button>
        ))}
      </div>
      {groupByFolder(shown, kind, folders).map((g) => (
        <details key={g.id} open className="rounded border bg-gray-50 p-2">
          <summary className="cursor-pointer text-sm">
            <span className="font-medium">📁 {g.name}</span> <span className="text-gray-500">({g.items.length} {noun}{g.pages ? ` · dùng cho: ${g.pages}` : ""})</span>
          </summary>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {g.items.map((img) => <ImageCard key={`${img.id}-${img.captions.length}-${img.enabled}`} image={img} onChanged={changed} />)}
          </ul>
        </details>
      ))}
      {list && shown.length === 0 && <p className="text-sm text-gray-500">Không có {noun} nào.</p>}
    </section>
  );
}

/** Chia kho theo thư mục Drive: ảnh luôn ở thư mục post-fb; video theo thư mục Reels của các Page, xếp theo tên. */
function groupByFolder(items: BankImage[], kind: "image" | "reel", folders?: Map<string, FolderInfo>) {
  const groups = new Map<string, BankImage[]>();
  for (const img of items) {
    const id = kind === "reel" ? (img.folderId ?? "") : "post-fb";
    groups.set(id, [...(groups.get(id) ?? []), img]);
  }
  return [...groups]
    .map(([id, list]) => {
      const info = folders?.get(id);
      const name = kind === "image" ? "post-fb" : (info?.name ?? "Thư mục không còn Page nào dùng");
      return { id, name, pages: info?.pages.join(", "), items: list };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
