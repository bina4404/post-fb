import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { TIME_ZONES, useTz } from "../time";
import { ImageBank } from "./ImageBank";
import { Button, ErrorText, inputClass } from "./ui";

type AutoPage = { id: number; name: string; autoEnabled: boolean; status: string; times: number[]; upcoming: number };
type Overview = { pages: AutoPage[]; readyImages: number; minImagesNeeded: number };
type PlanSummary = { created: number; shortages: number };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const planText = (r: PlanSummary) =>
  `Đã lên lịch ${r.created} bài mới cho 7 ngày tới.${r.shortages ? ` ${r.shortages} khung giờ chưa có ảnh phù hợp (cần thêm ảnh có caption).` : ""}`;

function PageTimes({ page, onSaved }: { page: AutoPage; onSaved: (message: string) => void }) {
  const [enabled, setEnabled] = useState(page.autoEnabled);
  const [times, setTimes] = useState(page.times);
  const [input, setInput] = useState("09:00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = enabled !== page.autoEnabled || times.join() !== page.times.join();

  function add() {
    const [h = 0, m = 0] = input.split(":").map(Number);
    const minute = h * 60 + m;
    if (!times.includes(minute)) setTimes([...times, minute].sort((a, b) => a - b));
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(`${page.name}: ${planText(await api<PlanSummary>(`/auto/pages/${page.id}`, { method: "PUT", json: { autoEnabled: enabled, times } }))}`);
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
        <span className="text-gray-500">{page.upcoming} bài tự động sắp tới</span>
        {page.status !== "ok" && <span className="text-red-700">Page cần kết nối lại: bài sẽ nằm chờ</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {times.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1">
            {hhmm(t)}
            <button aria-label={`Xoá giờ ${hhmm(t)}`} className="text-red-700" onClick={() => setTimes(times.filter((x) => x !== t))}>×</button>
          </span>
        ))}
        <input className={`${inputClass} w-auto`} type="time" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Giờ đăng" />
        <Button onClick={add}>Thêm giờ</Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={save}>Lưu</Button>
      </div>
      <ErrorText error={error} />
    </li>
  );
}

export function AutoPosting() {
  const tz = useTz();
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => api<Overview>("/auto").then(setData, (e: Error) => setMessage(e.message)), []);
  useEffect(() => void load(), [load]);

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
          {data?.pages.map((p) => <PageTimes key={`${p.id}-${p.times.join()}-${p.autoEnabled}`} page={p} onSaved={(m) => (setMessage(m), void load())} />)}
        </ul>
        {data && data.pages.length === 0 && <p className="text-sm text-gray-500">Chưa có Page nào được bật (tab Tài khoản).</p>}
      </section>
      <ImageBank onChanged={() => void load()} />
    </section>
  );
}
