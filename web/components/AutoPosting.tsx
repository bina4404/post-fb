import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { TIME_ZONES, useTz } from "../time";
import { ImageBank, type FolderInfo } from "./ImageBank";
import { Button, ErrorText, inputClass } from "./ui";

type AutoPage = {
  id: number;
  name: string;
  autoEnabled: boolean;
  status: string;
  times: number[];
  reelTimes: number[];
  upcoming: number;
  upcomingReels: number;
  reelFolderId: string | null;
  reelFolderName: string | null;
  readyVideos: number;
};
type Folder = { id: string; name: string };
type Overview = { pages: AutoPage[]; readyImages: number; minImagesNeeded: number };
type PlanSummary = { created: number; shortages: number };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const planText = (r: PlanSummary) =>
  `Đã lên lịch ${r.created} bài mới cho 7 ngày tới.${r.shortages ? ` ${r.shortages} khung giờ chưa có ảnh phù hợp (cần thêm ảnh có caption).` : ""}`;

/** Danh sách giờ đăng (ảnh hoặc Reels) của một Page, thêm/xoá từng giờ. */
function TimeList({ label, times, onChange }: { label: string; times: number[]; onChange: (times: number[]) => void }) {
  const [input, setInput] = useState("09:00");
  function add() {
    const [h = 0, m = 0] = input.split(":").map(Number);
    const minute = h * 60 + m;
    if (!times.includes(minute)) onChange([...times, minute].sort((a, b) => a - b));
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 text-gray-600">{label}</span>
      {times.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1">
          {hhmm(t)}
          <button aria-label={`Xoá ${label} ${hhmm(t)}`} className="text-red-700" onClick={() => onChange(times.filter((x) => x !== t))}>×</button>
        </span>
      ))}
      <input className={`${inputClass} w-auto`} type="time" value={input} onChange={(e) => setInput(e.target.value)} aria-label={label} />
      <Button onClick={add}>Thêm giờ</Button>
    </div>
  );
}

function PageTimes({ page, folders, onSaved }: { page: AutoPage; folders: Folder[] | null; onSaved: (message: string) => void }) {
  const [enabled, setEnabled] = useState(page.autoEnabled);
  const [times, setTimes] = useState(page.times);
  const [reelTimes, setReelTimes] = useState(page.reelTimes);
  const [folder, setFolder] = useState<Folder | null>(page.reelFolderId ? { id: page.reelFolderId, name: page.reelFolderName ?? page.reelFolderId } : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folderChanged = (folder?.id ?? null) !== page.reelFolderId;
  const dirty = enabled !== page.autoEnabled || times.join() !== page.times.join() || reelTimes.join() !== page.reelTimes.join() || folderChanged;
  // Thư mục đang chọn có thể không còn trong danh sách (bị xoá/đổi quyền): vẫn hiện để biết.
  const options = folder && folders && !folders.some((f) => f.id === folder.id) ? [folder, ...folders] : (folders ?? (folder ? [folder] : []));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const json = { autoEnabled: enabled, times, reelTimes, ...(folderChanged ? { reelFolder: folder } : {}) };
      onSaved(`${page.name}: ${planText(await api<PlanSummary>(`/auto/pages/${page.id}`, { method: "PUT", json }))}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 rounded border bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {page.name}
        </label>
        <span className="text-gray-500">{page.upcoming} bài ảnh · {page.upcomingReels} Reels sắp tới</span>
        {page.status !== "ok" && <span className="text-red-700">Page cần kết nối lại: bài sẽ nằm chờ</span>}
      </div>
      <TimeList label="Giờ đăng ảnh" times={times} onChange={setTimes} />
      <TimeList label="Giờ Reels" times={reelTimes} onChange={setReelTimes} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 text-gray-600">Thư mục video</span>
        <select
          className={`${inputClass} w-auto max-w-xs`}
          aria-label={`Thư mục video Reels của ${page.name}`}
          value={folder?.id ?? ""}
          onChange={(e) => setFolder(options.find((f) => f.id === e.target.value) ?? null)}
        >
          <option value="">— Chưa chọn (không đăng Reels) —</option>
          {options.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {page.reelFolderId && !folderChanged && (
          <span className={page.readyVideos ? "text-gray-500" : "text-amber-700"}>{page.readyVideos} video sẵn sàng (có caption)</span>
        )}
        {reelTimes.length > 0 && !folder && <span className="text-amber-700">Chọn thư mục video để đăng Reels</span>}
      </div>
      <Button variant="primary" disabled={!dirty || busy} onClick={save}>Lưu</Button>
      <ErrorText error={error} />
    </li>
  );
}

export function AutoPosting() {
  const tz = useTz();
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const load = useCallback(() => api<Overview>("/auto").then(setData, (e: Error) => setMessage(e.message)), []);
  useEffect(() => void load(), [load]);
  // Chưa kết nối Google Drive thì không có danh sách thư mục; lỗi hiện ở thông báo chung.
  useEffect(() => void api<Folder[]>("/auto/folders").then(setFolders, (e: Error) => setMessage(`Không đọc được thư mục Drive: ${e.message}`)), []);
  // Thư mục video → tên thư mục và các Page đang dùng nó (nhiều Page có thể dùng chung một thư mục).
  const reelFolders = new Map<string, FolderInfo>();
  for (const p of data?.pages ?? []) {
    if (!p.reelFolderId) continue;
    const f = reelFolders.get(p.reelFolderId) ?? { name: p.reelFolderName ?? p.reelFolderId, pages: [] };
    reelFolders.set(p.reelFolderId, { ...f, pages: [...f.pages, p.name] });
  }

  async function planNow() {
    try {
      setMessage(planText(await api<PlanSummary>("/auto/plan", { method: "POST" })));
      void load();
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  const short = data && data.readyImages < data.minImagesNeeded;
  return (
    <section className="space-y-6">
      <div className="space-y-2 rounded border bg-white p-3 text-sm">
        <p>
          App tự lấy ngẫu nhiên ảnh trong kho (ưu tiên ảnh lâu chưa dùng) và một caption của ảnh đó, lên lịch trước <b>7 ngày</b> theo giờ đăng của từng Page
          ({TIME_ZONES.find((z) => z.id === tz)?.label}). Một ảnh không lặp lại trên cùng Page trong 7 ngày, và không lên 2 Page trong cùng 24 giờ.
          Thiếu ảnh thì khung giờ được để trống, không đăng lặp. Bài tự động hiện trong Thư viện, sửa hoặc xoá được như bài thường.
        </p>
        <p>
          <b>Reels:</b> mỗi Page chọn một thư mục video trên Drive (nhiều Page có thể dùng chung thư mục) và giờ đăng Reels riêng. Video dài 3–90 giây,
          dọc 9:16, có caption mới được đăng; quy tắc không lặp giống ảnh. Giờ ảnh và giờ Reels của một Page phải cách nhau ít nhất 10 phút.
        </p>
        {data && (
          <p className={short ? "font-medium text-amber-700" : "text-gray-600"}>
            Ảnh sẵn sàng (có caption, đang bật): {data.readyImages} · Cần tối thiểu: {data.minImagesNeeded}
            {short ? " · Thiếu ảnh: một số khung giờ sẽ bị bỏ trống." : ""}
          </p>
        )}
        <Button onClick={planNow}>Lên lịch 7 ngày ngay</Button>
      </div>
      {message && <p role="status" className="rounded bg-gray-100 p-2 text-sm">{message} <button className="ml-2 text-blue-700 underline" onClick={() => setMessage(null)}>Đóng</button></p>}
      <section className="space-y-2">
        <h2 className="font-semibold">Giờ đăng tự động theo Page</h2>
        <ul className="space-y-2">
          {data?.pages.map((p) => (
            <PageTimes
              key={`${p.id}-${p.times.join()}-${p.reelTimes.join()}-${p.reelFolderId}-${p.autoEnabled}`}
              page={p}
              folders={folders}
              onSaved={(m) => (setMessage(m), void load())}
            />
          ))}
        </ul>
        {data && data.pages.length === 0 && <p className="text-sm text-gray-500">Chưa có Page nào được bật (tab Tài khoản).</p>}
      </section>
      <ImageBank kind="image" onChanged={() => void load()} />
      <ImageBank kind="reel" folders={reelFolders} onChanged={() => void load()} />
    </section>
  );
}
