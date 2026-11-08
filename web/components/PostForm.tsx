import { useState, type FormEvent } from "react";
import { api, type Destinations, type Post } from "../api";
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

  async function save(publishNow: boolean) {
    if (pageIds.length === 0) return setError("Chọn ít nhất 1 Page Facebook");
    if (publishNow && !confirm(`Đăng ngay bài này lên ${pageIds.length} Page?`)) return;
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
        ...(post || publishNow ? {} : { scheduledAt: scheduledAt || null }),
      };
      const saved = await api<Post>(post ? `/posts/${post.id}` : "/posts", { method: post ? "PATCH" : "POST", json: body });
      if (publishNow) await api(`/posts/${saved.id}/publish-now`, { method: "POST" });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => (e.preventDefault(), void save(false));
  return (
    <form onSubmit={submit} className="space-y-4 rounded border bg-white p-4">
      <Field label="Caption">
        <textarea className={inputClass} rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} required />
      </Field>
      <Field label="Link">
        <input className={inputClass} type="url" value={link} onChange={(e) => setLink(e.target.value)} />
      </Field>
      <ImagePicker value={image} onChange={setImage} />
      <PagePicker pages={pages} selected={pageIds} onChange={setPageIds} />
      {!post && (
        <Field label="Giờ đăng (giờ Bangkok, để trống = nháp)">
          <input className={inputClass} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
      )}
      <ErrorText error={error} />
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button type="submit" variant="primary" disabled={busy}>{post ? "Lưu thay đổi" : scheduledAt ? "Tạo & lên lịch" : "Lưu nháp"}</Button>
        <Button type="button" variant="success" disabled={busy} onClick={() => void save(true)}>{post ? "Lưu & đăng ngay" : "Đăng ngay"}</Button>
        <Button type="button" disabled={busy} onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}
