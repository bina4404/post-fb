import { useEffect, useState } from "react";
import { api, type Destinations, type LibraryPage, type Post, type PostGroup } from "../api";
import { formatDay, startOfLocalDay, useTz } from "../time";
import { PostRow } from "./PostList";
import { Button, inputClass } from "./ui";

const GROUPS: { id: PostGroup | "all"; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "scheduled", label: "Đã lên lịch" },
  { id: "draft", label: "Nháp" },
  { id: "failed", label: "Lỗi" },
  { id: "published", label: "Đã đăng" },
];

type Props = { dest: Destinations; reloadKey: number; onEdit: (p: Post) => void; onChanged: () => void };

/** Chờ người dùng gõ xong (350 ms) rồi mới tìm, để không gọi API sau mỗi phím. */
function useDebounced(value: string, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Tab "Đã lên lịch": nhóm bài theo ngày đăng (theo múi giờ đang chọn) để nhìn lịch từng ngày. */
function dayLabel(ms: number, tz: Parameters<typeof formatDay>[1]) {
  const day = startOfLocalDay(ms, tz);
  if (day === startOfLocalDay(Date.now(), tz)) return "Hôm nay";
  if (day === startOfLocalDay(Date.now(), tz, 1)) return "Ngày mai";
  return formatDay(day, tz);
}

function BulkBar({ ids, onDone }: { ids: number[]; onDone: (message: string) => void }) {
  const tz = useTz();
  const [busy, setBusy] = useState(false);
  async function run(action: "queue" | "delete") {
    if (action === "delete" && !confirm(`Xoá ${ids.length} bài đã chọn? Bài đã/đang đăng sẽ được giữ lại.`)) return;
    setBusy(true);
    try {
      const r = await api<{ done: number[]; skipped: { id: number; reason: string }[] }>("/posts/bulk", { method: "POST", json: { ids, action, tz } });
      const verb = action === "queue" ? "Đã xếp vào khung giờ" : "Đã xoá";
      const reasons = [...new Set(r.skipped.map((s) => s.reason))].join("; ");
      onDone(`${verb} ${r.done.length} bài${r.skipped.length ? `; bỏ qua ${r.skipped.length} bài (${reasons})` : ""}.`);
    } catch (err) {
      onDone(`Lỗi: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded border border-blue-300 bg-blue-50 p-2 text-sm">
      <span className="font-medium">Đã chọn {ids.length} bài</span>
      <Button disabled={busy} onClick={() => run("queue")}>Xếp vào khung giờ</Button>
      <Button disabled={busy} className="text-red-700" onClick={() => run("delete")}>Xoá</Button>
    </div>
  );
}

function Toolbar({ group, setGroup, counts, q, setQ, pageId, setPageId, dest }: {
  group: PostGroup | "all"; setGroup: (g: PostGroup | "all") => void; counts?: LibraryPage["counts"];
  q: string; setQ: (v: string) => void; pageId: string; setPageId: (v: string) => void; dest: Destinations;
}) {
  const pages = dest.accounts.filter((a) => a.platform === "facebook");
  return (
    <div className="space-y-2">
      <div role="tablist" className="flex flex-wrap gap-1 border-b">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={group === g.id}
            onClick={() => setGroup(g.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${group === g.id ? "border-blue-600 font-semibold text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"}`}
          >
            {g.label} <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-700">{counts?.[g.id] ?? "…"}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <input className={`${inputClass} w-64 max-w-full`} type="search" placeholder="Tìm trong caption…" aria-label="Tìm bài" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${inputClass} w-auto`} value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="Lọc theo Page">
          <option value="">Mọi Page</option>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
    </div>
  );
}

export function Library({ dest, reloadKey, onEdit, onChanged }: Props) {
  const tz = useTz();
  const [group, setGroup] = useState<PostGroup | "all">("all");
  const [pageId, setPageId] = useState("");
  const [q, setQ] = useState("");
  const query = useDebounced(q);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<LibraryPage | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  // Đổi bộ lọc thì về trang đầu và bỏ chọn.
  useEffect(() => (setOffset(0), setSelected([])), [group, pageId, query]);
  useEffect(() => {
    const params = new URLSearchParams({ offset: String(offset) });
    if (group !== "all") params.set("group", group);
    if (pageId) params.set("page", pageId);
    if (query.trim()) params.set("q", query.trim());
    api<LibraryPage>(`/posts?${params}`).then(setData, (e: Error) => setMessage(e.message));
  }, [group, pageId, query, offset, reloadKey, refresh]);

  const changed = () => (setRefresh((n) => n + 1), onChanged());
  const items = data?.items ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const allOnPage = items.length > 0 && items.every((p) => selected.includes(p.id));
  const toggle = (id: number, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  return (
    <section className="space-y-3">
      <Toolbar group={group} setGroup={setGroup} counts={data?.counts} q={q} setQ={setQ} pageId={pageId} setPageId={setPageId} dest={dest} />
      {selected.length > 0 && <BulkBar ids={selected} onDone={(m) => (setMessage(m), setSelected([]), changed())} />}
      {message && <p role="status" className="rounded bg-gray-100 p-2 text-sm">{message} <button className="ml-2 text-blue-700 underline" onClick={() => setMessage(null)}>Đóng</button></p>}
      {items.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={allOnPage} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...items.map((p) => p.id)])] : selected.filter((id) => !items.some((p) => p.id === id)))} />
          Chọn tất cả {items.length} bài trên trang này
        </label>
      )}
      {data && items.length === 0 && <p className="text-sm text-gray-500">Không có bài nào khớp bộ lọc.</p>}
      <ul className="space-y-2">
        {items.map((p, i) => {
          const header = group === "scheduled" && p.scheduledAt !== null ? dayLabel(p.scheduledAt, tz) : null;
          const prev = items[i - 1];
          const showHeader = header && (!prev?.scheduledAt || dayLabel(prev.scheduledAt, tz) !== header);
          return (
            <li key={p.id} className="space-y-2">
              {showHeader && <h3 className="pt-2 text-sm font-semibold text-gray-700">{header}</h3>}
              <PostRow post={p} dest={dest} onEdit={onEdit} onChanged={changed} selected={selected.includes(p.id)} onSelect={(on) => toggle(p.id, on)} />
            </li>
          );
        })}
      </ul>
      {data && data.total > data.pageSize && (
        <nav className="flex items-center justify-center gap-3 text-sm" aria-label="Phân trang">
          <Button disabled={offset === 0} onClick={() => setOffset(offset - data.pageSize)}>‹ Trước</Button>
          <span>Trang {offset / data.pageSize + 1} / {pages} · {data.total} bài</span>
          <Button disabled={offset + data.pageSize >= data.total} onClick={() => setOffset(offset + data.pageSize)}>Sau ›</Button>
        </nav>
      )}
    </section>
  );
}
