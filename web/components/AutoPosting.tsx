import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { TIME_ZONES, useTz } from "../time";
import { ImageBank } from "./ImageBank";
import { Button, ErrorText, inputClass } from "./ui";

export type Topic = { id: number; name: string; brief: string; enabled: boolean };
type Kind = "image" | "reel" | "text";
type Slot = { minuteOfDay: number; kind: Kind; days: number; topicId: number | null };
type TopicStat = { topicId: number; measured: number; medianViews: number | null; weight: number };
type AutoPage = {
  id: number;
  name: string;
  autoEnabled: boolean;
  status: string;
  slots: Slot[];
  upcoming: number;
  upcomingReels: number;
  upcomingText: number;
  reelFolderId: string | null;
  reelFolderName: string | null;
  readyVideos: number;
  topicStats: TopicStat[];
};
type Folder = { id: string; name: string };
type Overview = { pages: AutoPage[]; readyImages: number; minImagesNeeded: number; aiEnabled: boolean };
type PlanSummary = { created: number; shortages: number };

const EVERY_DAY = 127;
// Hiện từ thứ Hai; bit theo getUTCDay (0 = Chủ nhật).
const WEEKDAYS = [
  { bit: 1, label: "T2" },
  { bit: 2, label: "T3" },
  { bit: 3, label: "T4" },
  { bit: 4, label: "T5" },
  { bit: 5, label: "T6" },
  { bit: 6, label: "T7" },
  { bit: 0, label: "CN" },
];
const KIND_LABEL: Record<Kind, string> = { image: "Ảnh", reel: "Reels", text: "Bài chữ" };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMinute = (v: string) => {
  const [h = 0, m = 0] = v.split(":").map(Number);
  return h * 60 + m;
};
const planText = (r: PlanSummary) =>
  `Đã lên lịch ${r.created} bài mới cho 7 ngày tới.${r.shortages ? ` ${r.shortages} khung giờ chưa có nội dung phù hợp (cần thêm ảnh/video/bài chữ có caption đã duyệt, đúng chủ đề).` : ""}`;

/**
 * Lịch tuần theo báo cáo phân tích page: Reels T2/T4/T6 19:30 (app tự xoay chủ đề theo hiệu quả),
 * ảnh cổ vật T7 12:00, bài chữ hỏi fan CN 18:00. Giờ theo ET nên cần chọn múi giờ New York.
 */
function reportSlots(topics: Topic[]): Slot[] {
  const relic = topics.find((t) => t.enabled && t.name.toLowerCase().includes("cổ vật"));
  return [
    { minuteOfDay: 12 * 60, kind: "image", days: 1 << 6, topicId: relic?.id ?? null },
    { minuteOfDay: 18 * 60, kind: "text", days: 1 << 0, topicId: null },
    { minuteOfDay: 19 * 60 + 30, kind: "reel", days: (1 << 1) | (1 << 3) | (1 << 5), topicId: null },
  ];
}

function SlotRow({ slot, topics, onChange, onRemove }: { slot: Slot; topics: Topic[]; onChange: (s: Slot) => void; onRemove: () => void }) {
  const toggle = (bit: number) => {
    const days = slot.days ^ (1 << bit);
    if (days) onChange({ ...slot, days });
  };
  return (
    <li className="flex flex-wrap items-center gap-2 rounded bg-gray-50 p-2">
      <input className={`${inputClass} w-auto`} type="time" aria-label="Giờ đăng" value={hhmm(slot.minuteOfDay)} onChange={(e) => onChange({ ...slot, minuteOfDay: toMinute(e.target.value) })} />
      <select className={`${inputClass} w-auto`} aria-label="Loại bài" value={slot.kind} onChange={(e) => onChange({ ...slot, kind: e.target.value as Kind })}>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      <span className="flex gap-1" role="group" aria-label="Ngày trong tuần">
        {WEEKDAYS.map((d) => {
          const on = (slot.days & (1 << d.bit)) !== 0;
          return (
            <button key={d.bit} type="button" aria-pressed={on} onClick={() => toggle(d.bit)} className={`rounded px-1.5 py-0.5 text-xs ${on ? "bg-blue-600 text-white" : "border border-gray-300 bg-white text-gray-600"}`}>
              {d.label}
            </button>
          );
        })}
      </span>
      <select className={`${inputClass} w-auto max-w-56`} aria-label="Chủ đề" value={slot.topicId ?? ""} onChange={(e) => onChange({ ...slot, topicId: e.target.value ? Number(e.target.value) : null })}>
        <option value="">App tự chọn chủ đề</option>
        {topics.filter((t) => t.enabled || t.id === slot.topicId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button aria-label={`Xoá giờ ${hhmm(slot.minuteOfDay)}`} className="text-red-700" onClick={onRemove}>×</button>
    </li>
  );
}

function TopicStats({ stats, topics }: { stats: TopicStat[]; topics: Topic[] }) {
  const rows = stats.filter((s) => topics.find((t) => t.id === s.topicId)?.enabled || s.measured > 0);
  if (!rows.some((s) => s.measured > 0)) return <p className="text-xs text-gray-500">Chưa có bài nào được đo (app lấy lượt xem từ Facebook 7 ngày sau khi đăng).</p>;
  return (
    <table className="text-xs">
      <thead>
        <tr className="text-left text-gray-500">
          <th className="pr-4 font-normal">Chủ đề</th>
          <th className="pr-4 font-normal">Bài đã đo</th>
          <th className="pr-4 font-normal">Trung vị lượt xem</th>
          <th className="font-normal">Tỉ trọng khi app tự chọn</th>
        </tr>
      </thead>
      <tbody>
        {rows.sort((a, b) => b.weight - a.weight).map((s) => (
          <tr key={s.topicId}>
            <td className="pr-4">{topics.find((t) => t.id === s.topicId)?.name}</td>
            <td className="pr-4">{s.measured}</td>
            <td className="pr-4">{s.medianViews?.toLocaleString("vi-VN") ?? "—"}</td>
            <td>×{s.weight}{s.measured < 3 ? " (chưa đủ 3 bài)" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PageSchedule({ page, topics, folders, onSaved }: { page: AutoPage; topics: Topic[]; folders: Folder[] | null; onSaved: (message: string) => void }) {
  const [enabled, setEnabled] = useState(page.autoEnabled);
  const [slots, setSlots] = useState(page.slots);
  const [folder, setFolder] = useState<Folder | null>(page.reelFolderId ? { id: page.reelFolderId, name: page.reelFolderName ?? page.reelFolderId } : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folderChanged = (folder?.id ?? null) !== page.reelFolderId;
  const dirty = enabled !== page.autoEnabled || JSON.stringify(slots) !== JSON.stringify(page.slots) || folderChanged;
  // Thư mục đang chọn có thể không còn trong danh sách (bị xoá/đổi quyền): vẫn hiện để biết.
  const options = folder && folders && !folders.some((f) => f.id === folder.id) ? [folder, ...folders] : (folders ?? (folder ? [folder] : []));
  const sorted = (list: Slot[]) => [...list].sort((a, b) => a.minuteOfDay - b.minuteOfDay);
  const hasReels = slots.some((s) => s.kind === "reel");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const json = { autoEnabled: enabled, slots, ...(folderChanged ? { reelFolder: folder } : {}) };
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
        <span className="text-gray-500">Sắp tới: {page.upcoming} ảnh · {page.upcomingReels} Reels · {page.upcomingText} bài chữ</span>
        {page.status !== "ok" && <span className="text-red-700">Page cần kết nối lại: bài sẽ nằm chờ</span>}
      </div>
      <ul className="space-y-1">
        {slots.map((s, i) => (
          <SlotRow
            key={i}
            slot={s}
            topics={topics}
            onChange={(next) => setSlots(slots.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setSlots(slots.filter((_, j) => j !== i))}
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setSlots(sorted([...slots, { minuteOfDay: 9 * 60, kind: "image", days: EVERY_DAY, topicId: null }]))}>Thêm giờ đăng</Button>
        <Button
          title="Reels T2/T4/T6 19:30 (app tự xoay chủ đề), ảnh cổ vật T7 12:00, bài hỏi fan CN 18:00. Giờ theo ET: chọn múi giờ New York ở góc trên."
          onClick={() => setSlots(reportSlots(topics))}
        >
          Dùng lịch theo báo cáo
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-600">Thư mục video Reels</span>
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
        {hasReels && !folder && <span className="text-amber-700">Chọn thư mục video để đăng Reels</span>}
      </div>
      <Button variant="primary" disabled={!dirty || busy} onClick={save}>Lưu</Button>
      <ErrorText error={error} />
      <details>
        <summary className="cursor-pointer text-blue-700">Hiệu quả theo chủ đề</summary>
        <div className="mt-2"><TopicStats stats={page.topicStats} topics={topics} /></div>
      </details>
    </li>
  );
}

function TopicRow({ topic, onChanged }: { topic: Topic; onChanged: () => void }) {
  const [name, setName] = useState(topic.name);
  const [brief, setBrief] = useState(topic.brief);
  const [error, setError] = useState<string | null>(null);
  async function save(body: Partial<Topic>) {
    setError(null);
    try {
      await api(`/topics/${topic.id}`, { method: "PATCH", json: body });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const dirty = name !== topic.name || brief !== topic.brief;
  return (
    <li className={`space-y-1 rounded border bg-white p-2 text-sm ${topic.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} w-auto flex-1`} aria-label="Tên chủ đề" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={topic.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Đang dùng
        </label>
      </div>
      <textarea rows={2} className="w-full rounded border border-gray-300 px-2 py-1 text-xs" aria-label={`Mô tả cho AI của chủ đề ${topic.name}`} value={brief} onChange={(e) => setBrief(e.target.value)} />
      {dirty && <Button onClick={() => save({ name, brief })}>Lưu chủ đề</Button>}
      <ErrorText error={error} />
    </li>
  );
}

function Topics({ topics, onChanged }: { topics: Topic[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setError(null);
    try {
      await api("/topics", { method: "POST", json: { name } });
      setName("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer font-semibold">Chủ đề nội dung ({topics.filter((t) => t.enabled).length} đang dùng)</summary>
      <p className="text-sm text-gray-500">
        Gắn chủ đề cho từng ảnh/video ở kho bên dưới. Mô tả của chủ đề là thứ AI đọc khi viết caption. Tắt chủ đề thì app gỡ các bài tự động chưa đăng của chủ đề đó.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {topics.map((t) => <TopicRow key={`${t.id}-${t.name}-${t.brief}-${t.enabled}`} topic={t} onChanged={onChanged} />)}
      </ul>
      <div className="flex gap-2">
        <input className={`${inputClass} w-auto`} placeholder="Tên chủ đề mới" aria-label="Tên chủ đề mới" value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={!name.trim()} onClick={add}>Thêm chủ đề</Button>
      </div>
      <ErrorText error={error} />
    </details>
  );
}

export function AutoPosting() {
  const tz = useTz();
  const [data, setData] = useState<Overview | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const load = useCallback(() => {
    void api<Overview>("/auto").then(setData, (e: Error) => setMessage(e.message));
    void api<Topic[]>("/topics").then(setTopics, (e: Error) => setMessage(e.message));
  }, []);
  useEffect(load, [load]);
  // Chưa kết nối Google Drive thì không có danh sách thư mục; lỗi hiện ở thông báo chung.
  useEffect(() => void api<Folder[]>("/auto/folders").then(setFolders, (e: Error) => setMessage(`Không đọc được thư mục Drive: ${e.message}`)), []);
  const folderNames = new Map((data?.pages ?? []).filter((p) => p.reelFolderId).map((p) => [p.reelFolderId!, p.reelFolderName ?? ""]));

  async function planNow() {
    try {
      setMessage(planText(await api<PlanSummary>("/auto/plan", { method: "POST" })));
      load();
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  const short = data && data.readyImages < data.minImagesNeeded;
  const bank = { topics, aiEnabled: data?.aiEnabled ?? false, onChanged: load };
  return (
    <section className="space-y-6">
      <div className="space-y-2 rounded border bg-white p-3 text-sm">
        <p>
          App lên lịch trước <b>7 ngày</b> theo giờ đăng của từng Page ({TIME_ZONES.find((z) => z.id === tz)?.label}). Mỗi giờ đăng có loại bài, các ngày trong tuần và
          chủ đề. Giờ để <b>App tự chọn chủ đề</b> thì chủ đề có trung vị lượt xem cao hơn (đo 7 ngày sau khi đăng) được chọn nhiều hơn; chủ đề kém vẫn giữ ít nhất 1/4 tỉ trọng để đo tiếp.
        </p>
        <p>
          Một media không lặp trên cùng Page trong 7 ngày, không lên 2 Page trong 24 giờ, và <b>mỗi caption chỉ đăng một lần trên mỗi Page</b>. Thiếu nội dung thì khung giờ được để trống.
          Bài tự động hiện trong Thư viện, sửa hoặc xoá được như bài thường.
        </p>
        <p>
          <b>AI viết caption:</b>{" "}
          {data?.aiEnabled
            ? "mỗi giờ AI gợi ý caption cho vài ảnh/video chưa có gợi ý, và viết bài hỏi fan khi kho bài chữ sắp hết. Gợi ý chỉ được đăng sau khi bạn bấm Duyệt."
            : "chưa bật. Đặt secret ANTHROPIC_API_KEY cho Worker để bật."}
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
      <Topics topics={topics} onChanged={load} />
      <section className="space-y-2">
        <h2 className="font-semibold">Lịch đăng tự động theo Page</h2>
        <ul className="space-y-2">
          {data?.pages.map((p) => (
            <PageSchedule key={`${p.id}-${JSON.stringify(p.slots)}-${p.reelFolderId}-${p.autoEnabled}`} page={p} topics={topics} folders={folders} onSaved={(m) => (setMessage(m), load())} />
          ))}
        </ul>
        {data && data.pages.length === 0 && <p className="text-sm text-gray-500">Chưa có Page nào được bật (tab Tài khoản).</p>}
      </section>
      <ImageBank kind="image" {...bank} />
      <ImageBank kind="reel" folderNames={folderNames} {...bank} />
      <ImageBank kind="text" {...bank} />
    </section>
  );
}
