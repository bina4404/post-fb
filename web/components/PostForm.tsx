import { useState, type FormEvent } from "react";
import { api, type Destinations, type Post } from "../api";
import { Button, ErrorText, Field, inputClass } from "./ui";

type Props = { post?: Post; dest: Destinations; onSaved: () => void; onCancel: () => void };

async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  return (await api<{ key: string }>("/media", { method: "POST", body: form })).key;
}

export function PostForm({ post, dest, onSaved, onCancel }: Props) {
  const pages = dest.accounts.filter((a) => a.platform === "facebook" && a.enabled);
  const boards = dest.boards.filter((b) => b.enabled && dest.accounts.some((a) => a.id === b.accountId && a.enabled));
  const fbTarget = post?.targets.find((t) => t.platform === "facebook");
  const pinTarget = post?.targets.find((t) => t.platform === "pinterest");
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [link, setLink] = useState(post?.link ?? "");
  const [imageUrl, setImageUrl] = useState(post?.imageUrl ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [pageId, setPageId] = useState(fbTarget ? String(fbTarget.accountId) : "");
  const [boardId, setBoardId] = useState(pinTarget?.boardId ? String(pinTarget.boardId) : "");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const imageKey = file ? await uploadImage(file) : imageUrl ? null : (post?.imageKey ?? null);
      const body = {
        caption,
        link: link || null,
        imageKey,
        imageUrl: imageKey ? null : imageUrl || null,
        facebookAccountId: pageId ? Number(pageId) : null,
        pinterestBoardId: boardId ? Number(boardId) : null,
        ...(post ? {} : { scheduledAt: scheduledAt || null }),
      };
      await api(post ? `/posts/${post.id}` : "/posts", { method: post ? "PATCH" : "POST", json: body });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded border bg-white p-4">
      <Field label="Caption">
        <textarea className={inputClass} rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} required />
      </Field>
      <Field label="Link">
        <input className={inputClass} type="url" value={link} onChange={(e) => setLink(e.target.value)} />
      </Field>
      <Field label={post?.imageKey && !file ? "Ảnh (đang có ảnh đã tải lên, chọn file để thay)" : "Ảnh (JPEG ≤4MB, PNG ≤1MB)"}>
        <input type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="…hoặc URL ảnh (https)">
        <input className={inputClass} type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} disabled={!!file} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Page Facebook">
          <select className={inputClass} value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">— không đăng —</option>
            {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Board Pinterest">
          <select className={inputClass} value={boardId} onChange={(e) => setBoardId(e.target.value)}>
            <option value="">— không đăng —</option>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      </div>
      {pages.length + boards.length === 0 && (
        <p className="text-sm text-amber-700">Chưa có Page/Board nào được kết nối và bật.</p>
      )}
      {!post && (
        <Field label="Giờ đăng (giờ Bangkok, để trống = nháp)">
          <input className={inputClass} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
      )}
      <ErrorText error={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy} className="bg-blue-600 text-white hover:bg-blue-700">{post ? "Lưu" : "Tạo bài"}</Button>
        <Button type="button" onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}
