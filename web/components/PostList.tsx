import { useState } from "react";
import { api, type Destinations, type Post } from "../api";
import { formatTime, localInputToIso, useTz } from "../time";
import { Button, ErrorText, inputClass, StatusBadge } from "./ui";

type Props = { posts: Post[]; dest: Destinations; onEdit: (p: Post) => void; onChanged: () => void };

function targetLabel(t: Post["targets"][number], dest: Destinations) {
  return `Facebook · ${dest.accounts.find((a) => a.id === t.accountId)?.name ?? t.accountId}`;
}

function PostRow({ post, dest, onEdit, onChanged }: { post: Post } & Omit<Props, "posts">) {
  const [when, setWhen] = useState("");
  const tz = useTz();
  const [error, setError] = useState<string | null>(null);
  const locked = post.targets.some((t) => t.status === "published" || t.status === "publishing");
  // "Đăng ngay" chỉ đẩy target chưa đi; target lỗi phải dùng "Đăng lại" ở tab Lịch đăng.
  const pending = post.targets.filter((t) => t.status === "draft" || t.status === "scheduled").length;

  async function run(path: string, init: Parameters<typeof api>[1]) {
    setError(null);
    try {
      await api(path, init);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className="space-y-2 rounded border bg-white p-3">
      <div className="flex gap-3">
        {post.imageKey && <img src={`/api/media/${post.imageKey}?thumb=1`} alt="" loading="lazy" className="h-16 w-16 rounded object-cover" />}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 whitespace-pre-line text-sm">{post.caption}</p>
          <p className="text-xs text-gray-500">{post.scheduledAt ? `Lịch: ${formatTime(post.scheduledAt, tz)}` : "Nháp"}</p>
          <ul className="mt-1 flex flex-wrap gap-2 text-xs">
            {post.targets.map((t) => (
              <li key={t.id} className="flex items-center gap-1">
                {targetLabel(t, dest)} <StatusBadge status={t.status} />
                {t.lastError && <span className="text-red-700">{t.lastError}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} w-auto`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Giờ đăng" />
        <Button disabled={!when} onClick={() => run(`/posts/${post.id}/schedule`, { method: "POST", json: { scheduledAt: localInputToIso(when, tz) ?? when } })}>Đặt giờ</Button>
        <Button onClick={() => run(`/posts/${post.id}/schedule`, { method: "POST", json: { queue: true, tz } })}>Xếp vào khung giờ</Button>
        {post.scheduledAt && <Button onClick={() => run(`/posts/${post.id}/unschedule`, { method: "POST" })}>Huỷ lịch</Button>}
        {pending > 0 && (
          <Button
            variant="success"
            onClick={() => confirm(`Đăng ngay bài này lên ${pending} Page?`) && run(`/posts/${post.id}/publish-now`, { method: "POST" })}
          >
            Đăng ngay
          </Button>
        )}
        {!locked && <Button onClick={() => onEdit(post)}>Sửa</Button>}
        {!locked && (
          <Button className="text-red-700" onClick={() => confirm("Xoá bài này?") && run(`/posts/${post.id}`, { method: "DELETE" })}>Xoá</Button>
        )}
      </div>
      <ErrorText error={error} />
    </li>
  );
}

export function PostList(props: Props) {
  if (props.posts.length === 0) return <p className="text-sm text-gray-500">Chưa có bài nào.</p>;
  return (
    <ul className="space-y-3">
      {props.posts.map((p) => <PostRow key={p.id} post={p} {...props} />)}
    </ul>
  );
}
