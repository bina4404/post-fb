import { useCallback, useEffect, useState, type DragEvent } from "react";
import { api } from "../api";
import { formatTime, useTz } from "../time";
import type { Topic } from "./AutoPosting";
import { Button, ErrorText, inputClass } from "./ui";

type Kind = "image" | "reel" | "text";
export type BankImage = {
  id: number;
  driveFileId: string;
  name: string;
  kind: Kind;
  folderId: string | null;
  topicId: number | null;
  captions: string[];
  suggestions: string[];
  enabled: boolean;
  lastUsedAt: number | null;
  nextUseAt: number | null;
};
const MAX_CAPTIONS = 10;
const ACCEPTED = ["image/jpeg", "image/png"];
type Filter = "all" | "pending" | "missing" | "off";
type Shared = { topics: Topic[]; aiEnabled: boolean };

function TopicSelect({ value, topics, disabled, onChange }: { value: number | null; topics: Topic[]; disabled: boolean; onChange: (id: number | null) => void }) {
  return (
    <select className={`${inputClass} w-auto max-w-full text-xs`} aria-label="Chủ đề" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">Chưa gắn chủ đề</option>
      {topics.filter((t) => t.enabled || t.id === value).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

/** Gợi ý của AI: Duyệt (chuyển vào caption, được lên lịch) hoặc Bỏ. */
function Suggestions({ image, busy, save, onDeleteText }: { image: BankImage; busy: boolean; save: (body: object) => void; onDeleteText: () => void }) {
  if (image.suggestions.length === 0) return null;
  const without = (s: string) => image.suggestions.filter((x) => x !== s);
  const discard = (s: string) =>
    // Bài chữ chưa duyệt mà bỏ gợi ý cuối thì không còn gì: xoá luôn khỏi kho.
    image.kind === "text" && image.captions.length === 0 && image.suggestions.length === 1 ? onDeleteText() : save({ suggestions: without(s) });
  return (
    <div className="space-y-1 rounded bg-amber-50 p-2">
      <p className="text-xs font-medium text-amber-800">AI gợi ý, chờ duyệt ({image.suggestions.length})</p>
      {image.suggestions.map((s) => (
        <div key={s} className="space-y-1 border-t border-amber-100 pt-1 first:border-0 first:pt-0">
          <p className="whitespace-pre-wrap text-xs">{s}</p>
          <div className="flex gap-2">
            <Button disabled={busy || image.captions.length >= MAX_CAPTIONS} onClick={() => save({ captions: [...image.captions, s], suggestions: without(s) })}>Duyệt</Button>
            <Button disabled={busy} onClick={() => discard(s)}>Bỏ</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ImageCard({ image, folderName, topics, aiEnabled, onChanged }: Shared & { image: BankImage; folderName?: string; onChanged: (message?: string) => void }) {
  const tz = useTz();
  const [captions, setCaptions] = useState(() => Array.from({ length: MAX_CAPTIONS }, (_, i) => image.captions[i] ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = image.captions.length;
  const text = image.kind === "text";

  async function run(work: () => Promise<string | undefined>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await work());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const save = (body: object) =>
    run(async () => {
      const r = await api<{ plan: { created: number } }>(`/images/${image.id}`, { method: "PATCH", json: body });
      return r.plan.created ? `Đã lên lịch thêm ${r.plan.created} bài tự động.` : undefined;
    });
  const suggest = () => run(async () => (await api(`/images/${image.id}/suggest`, { method: "POST" }), "AI đã viết thêm gợi ý caption, xem và duyệt ở thẻ của nó."));
  const remove = () => run(async () => (await api(`/images/${image.id}`, { method: "DELETE" }), undefined));

  return (
    <li className={`space-y-2 rounded border bg-white p-2 text-sm ${image.enabled ? "" : "opacity-60"}`}>
      <div className="flex gap-2">
        {!text && <img src={`/api/media/${image.driveFileId}?thumb=1`} alt={image.name} loading="lazy" className="h-20 w-20 shrink-0 rounded object-cover" />}
        <div className="min-w-0 flex-1 space-y-1">
          {text ? <p className="whitespace-pre-wrap">{image.captions[0] ?? image.suggestions[0]}</p> : <p className="truncate font-medium" title={image.name}>{image.name}</p>}
          {image.kind === "reel" && <p className="truncate text-xs text-gray-500">Thư mục: {folderName || "không còn Page nào dùng"}</p>}
          {!text && <p className={filled ? "text-gray-600" : "font-medium text-amber-700"}>{filled}/{MAX_CAPTIONS} caption{filled ? "" : " (chưa dùng được)"}</p>}
          {text && !filled && <p className="text-xs font-medium text-amber-700">Chưa duyệt: chưa được đăng</p>}
          <p className="text-xs text-gray-500">
            {image.lastUsedAt ? `Đăng gần nhất: ${formatTime(image.lastUsedAt, tz)}` : "Chưa đăng lần nào"}
            {image.nextUseAt ? ` · Sắp đăng: ${formatTime(image.nextUseAt, tz)}` : ""}
          </p>
          <TopicSelect value={image.topicId} topics={topics} disabled={busy} onChange={(topicId) => save({ topicId })} />
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={image.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} /> Dùng cho đăng tự động
          </label>
        </div>
      </div>
      {!(text && !filled) && <Suggestions image={image} busy={busy} save={save} onDeleteText={remove} />}
      {text && !filled && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => save({ captions: image.suggestions.slice(0, 1), suggestions: [] })}>Duyệt</Button>
          <Button disabled={busy} onClick={remove}>Bỏ</Button>
        </div>
      )}
      {!text && aiEnabled && image.captions.length < MAX_CAPTIONS && (
        <Button disabled={busy} onClick={suggest} title="Claude xem ảnh nhỏ, tên file và chủ đề rồi viết 3 caption tiếng Anh theo công thức của báo cáo">
          {busy ? "Đang viết…" : "AI viết thêm caption"}
        </Button>
      )}
      {text && filled > 0 && <Button disabled={busy} onClick={() => confirm("Xoá bài chữ này khỏi kho?") && remove()}>Xoá bài chữ</Button>}
      {!text && (
        <details>
          <summary className="cursor-pointer text-blue-700">Sửa caption</summary>
          <div className="mt-2 space-y-1">
            {captions.map((value, i) => (
              <textarea
                key={i}
                rows={2}
                aria-label={`Caption ${i + 1}`}
                placeholder={`Caption ${i + 1}`}
                className="w-full rounded border border-gray-300 px-2 py-1"
                value={value}
                onChange={(e) => setCaptions(captions.map((c, j) => (j === i ? e.target.value : c)))}
              />
            ))}
            <Button variant="primary" disabled={busy} onClick={() => save({ captions })}>Lưu caption</Button>
          </div>
        </details>
      )}
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

/** Viết tay một bài chữ (đã duyệt), hoặc nhờ AI viết 4 bài hỏi fan (chờ duyệt). */
function TextComposer({ aiEnabled, onDone }: { aiEnabled: boolean; onDone: (message: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onDone(await work());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <textarea rows={2} className="w-full rounded border border-gray-300 px-2 py-1" placeholder="Viết bài hỏi fan, ví dụ: Which mystery should we dig into next: Elvis, Tupac or Antarctica?" aria-label="Bài chữ mới" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !text.trim()} onClick={() => run(async () => (await api("/images/text", { method: "POST", json: { text } }), setText(""), "Đã thêm bài chữ vào kho."))}>Thêm bài chữ</Button>
        {aiEnabled && (
          <Button disabled={busy} onClick={() => run(async () => `AI đã viết ${(await api<{ created: number }>("/images/fan-posts", { method: "POST" })).created} bài hỏi fan, chờ bạn duyệt.`)}>
            {busy ? "Đang viết…" : "AI viết 4 bài hỏi fan"}
          </Button>
        )}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

type BankProps = Shared & { kind: Kind; folderNames?: Map<string, string>; onChanged: () => void };
const TITLE: Record<Kind, string> = { image: "Kho ảnh", reel: "Kho video Reels", text: "Bài chữ (hỏi fan)" };
const NOUN: Record<Kind, string> = { image: "ảnh", reel: "video", text: "bài" };

/** Kho ảnh (thư mục post-fb), kho video Reels (thư mục video của các Page) hoặc kho bài chữ. */
export function ImageBank({ kind, folderNames, topics, aiEnabled, onChanged }: BankProps) {
  const reels = kind === "reel";
  const noun = NOUN[kind];
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
  const isPending = (i: BankImage) => i.suggestions.length > 0;
  const isMissing = (i: BankImage) => i.enabled && i.captions.length === 0;
  const shown = mine.filter((i) => (filter === "pending" ? isPending(i) : filter === "missing" ? isMissing(i) : filter === "off" ? !i.enabled : true));
  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "Tất cả" },
    { id: "pending", label: `Chờ duyệt (${mine.filter(isPending).length})` },
    ...(kind === "text" ? [] : [{ id: "missing" as const, label: `Thiếu caption (${mine.filter(isMissing).length})` }]),
    { id: "off", label: "Đang tắt" },
  ];
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{TITLE[kind]} ({list ? mine.length : "…"} {noun})</h2>
        {kind !== "text" && (
          <Button onClick={sync} title={reels ? "Đọc lại thư mục video của các Page trên Drive (app cũng tự đồng bộ mỗi giờ)" : "Đọc lại thư mục post-fb trên Drive (app cũng tự đồng bộ mỗi giờ)"}>
            Đồng bộ từ Drive
          </Button>
        )}
      </div>
      {kind === "reel" && (
        <p className="text-sm text-gray-500">Bỏ video vào thư mục đã chọn cho Page trên Google Drive, rồi bấm Đồng bộ từ Drive (app cũng tự đồng bộ mỗi giờ). Nhớ thêm caption cho video mới.</p>
      )}
      {kind === "image" && <Uploader onDone={(m) => changed(m)} />}
      {kind === "text" && (
        <>
          <p className="text-sm text-gray-500">Dùng cho giờ đăng loại Bài chữ. Mỗi bài chỉ đăng một lần trên mỗi Page.</p>
          <TextComposer aiEnabled={aiEnabled} onDone={(m) => changed(m)} />
        </>
      )}
      {message && <p role="status" className="rounded bg-gray-100 p-2 text-sm">{message} <button className="ml-2 text-blue-700 underline" onClick={() => setMessage(null)}>Đóng</button></p>}
      <div className="flex gap-3 text-sm">
        {filters.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={filter === f.id ? "font-semibold text-blue-700" : "text-gray-600"}>{f.label}</button>
        ))}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {shown.map((img) => (
          <ImageCard
            key={`${img.id}-${img.captions.length}-${img.suggestions.length}-${img.enabled}-${img.topicId}`}
            image={img}
            folderName={img.folderId ? folderNames?.get(img.folderId) : undefined}
            topics={topics}
            aiEnabled={aiEnabled}
            onChanged={changed}
          />
        ))}
      </ul>
      {list && shown.length === 0 && <p className="text-sm text-gray-500">Không có {noun} nào.</p>}
    </section>
  );
}
