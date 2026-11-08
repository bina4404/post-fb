import { useState, type FormEvent } from "react";
import { api, type Destinations, type Post } from "../api";
import { localInputToIso, TIME_ZONES, useTz } from "../time";
import { ImagePicker, type ImageChoice } from "./ImagePicker";
import { Button, ErrorText, Field, inputClass } from "./ui";

type Props = { post?: Post; dest: Destinations; onSaved: () => void; onCancel: () => void };

async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  return (await api<{ key: string }>("/media", { method: "POST", body: form })).key;
}

function PagePicker({ pages, selected, onChange }: { pages: { id: number; name: string }[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const toggle = (id: number, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  if (pages.length === 0) return <p className="text-sm text-amber-700">Chưa có Page nào được kết nối và bật (tab Tài khoản).</p>;
  return (
    <fieldset className="text-sm">
      <legend className="mb-1 font-medium">Đăng lên Page Facebook (chọn một hoặc nhiều)</legend>
      <div className="mb-1 flex gap-3 text-xs">
        <button type="button" className="text-blue-700 underline" onClick={() => onChange(pages.map((p) => p.id))}>Chọn tất cả</button>
        <button type="button" className="text-blue-700 underline" onClick={() => onChange([])}>Bỏ chọn</button>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {pages.map((p) => (
          <label key={p.id} className="flex items-center gap-2 rounded border px-2 py-1">
            <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
            {p.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function PostForm({ post, dest, onSaved, onCancel }: Props) {
  const pages = dest.accounts.filter((a) => a.platform === "facebook" && a.enabled);
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [link, setLink] = useState(post?.link ?? "");
  const [image, setImage] = useState<ImageChoice>({ file: null, imageKey: post?.imageKey ?? null, imageUrl: post?.imageUrl ?? "" });
  const [pageIds, setPageIds] = useState<number[]>(post?.targets.map((t) => t.accountId) ?? []);
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = useTz();

  /** save: lưu (nháp hoặc theo giờ đã nhập). now: lưu rồi đăng ngay. queue: lưu rồi xếp vào khung giờ trống sớm nhất. */
  async function save(mode: "save" | "now" | "queue") {
    if (pageIds.length === 0) return setError("Chọn ít nhất 1 Page Facebook");
    if (mode === "now" && !confirm(`Đăng ngay bài này lên ${pageIds.length} Page?`)) return;
    setBusy(true);
    setError(null);
    try {
      const imageKey = image.file ? await uploadImage(image.file) : image.imageKey;
      const body = {
        caption,
        link: link || null,
        imageKey,
        imageUrl: imageKey ? null : image.imageUrl || null,
        facebookAccountIds: pageIds,
        ...(post || mode !== "save" ? {} : { scheduledAt: scheduledAt ? (localInputToIso(scheduledAt, tz) ?? scheduledAt) : null }),
      };
      const saved = await api<Post>(post ? `/posts/${post.id}` : "/posts", { method: post ? "PATCH" : "POST", json: body });
      try {
        if (mode === "now") await api(`/posts/${saved.id}/publish-now`, { method: "POST" });
        if (mode === "queue") await api(`/posts/${saved.id}/schedule`, { method: "POST", json: { queue: true, tz } });
      } catch (err) {
        // Bài đã được lưu: báo lỗi rồi đóng form, để bấm lại không tạo bài trùng.
        alert(`Đã lưu bài, nhưng bước tiếp theo bị lỗi: ${(err as Error).message}`);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => (e.preventDefault(), void save("save"));
  return (
    <form onSubmit={submit} className="space-y-4 rounded border bg-white p-4">
      <Field label="Caption">
        <textarea className={`${inputClass} min-h-72 resize-y`} rows={12} value={caption} onChange={(e) => setCaption(e.target.value)} required />
      </Field>
      <Field label="Link">
        <input className={inputClass} type="url" value={link} onChange={(e) => setLink(e.target.value)} />
      </Field>
      <ImagePicker value={image} onChange={setImage} />
      <PagePicker pages={pages} selected={pageIds} onChange={setPageIds} />
      {!post && (
        <Field label={`Giờ đăng (${TIME_ZONES.find((z) => z.id === tz)?.label}; để trống = nháp)`}>
          <input className={inputClass} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
      )}
      <ErrorText error={error} />
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button type="submit" variant="primary" disabled={busy}>{post ? "Lưu thay đổi" : scheduledAt ? "Tạo & lên lịch" : "Lưu nháp"}</Button>
        <Button type="button" disabled={busy} onClick={() => void save("queue")} title="Xếp vào khung giờ trống sớm nhất (tab Khung giờ)">
          {post ? "Lưu & xếp vào khung giờ" : "Xếp vào khung giờ"}
        </Button>
        <Button type="button" variant="success" disabled={busy} onClick={() => void save("now")}>{post ? "Lưu & đăng ngay" : "Đăng ngay"}</Button>
        <Button type="button" disabled={busy} onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}
