import { useCallback, useEffect, useState } from "react";
import { api, type TargetRow } from "../api";
import { formatDay, startOfLocalDay, useTz, weekStart } from "../time";
import { TargetItem } from "./TargetItem";
import { Button, ErrorText, inputClass } from "./ui";

const STATUSES = ["draft", "scheduled", "publishing", "published", "failed"] as const;

function WeekCalendar({ start, rows, onChanged }: { start: number; rows: TargetRow[]; onChanged: () => void }) {
  const tz = useTz();
  const days = Array.from({ length: 7 }, (_, i) => startOfLocalDay(start, tz, i));
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
      {days.map((day) => {
        const items = rows
          .filter((r) => r.scheduledAt !== null && r.scheduledAt >= day && r.scheduledAt < startOfLocalDay(day, tz, 1))
          .sort((a, b) => a.scheduledAt! - b.scheduledAt!);
        return (
          <div key={day} className="min-h-24 space-y-2 rounded bg-gray-100 p-2">
            <h3 className="text-xs font-semibold">{formatDay(day, tz)}</h3>
            {items.map((t) => <TargetItem key={t.id} target={t} compact onChanged={onChanged} />)}
          </div>
        );
      })}
    </div>
  );
}

export function Dashboard() {
  const [view, setView] = useState<"list" | "week">("list");
  const [status, setStatus] = useState("");
  const tz = useTz();
  const [start, setStart] = useState(() => weekStart(Date.now(), tz));
  // Đổi múi giờ thì tuần được tính lại theo múi giờ mới.
  useEffect(() => setStart((s) => weekStart(s, tz)), [tz]);
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (view === "week") {
      q.set("from", String(start));
      q.set("to", String(startOfLocalDay(start, tz, 7)));
    }
    api<TargetRow[]>(`/targets?${q}`).then(setRows, (e: Error) => setError(e.message));
  }, [status, view, start, tz]);
  useEffect(load, [load]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Trạng thái">
          <option value="">Mọi trạng thái</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button onClick={() => setView(view === "list" ? "week" : "list")}>{view === "list" ? "Xem theo tuần" : "Xem danh sách"}</Button>
        {view === "week" && (
          <>
            <Button onClick={() => setStart(startOfLocalDay(start, tz, -7))} aria-label="Tuần trước">‹</Button>
            <span className="text-sm">{formatDay(start, tz)} – {formatDay(startOfLocalDay(start, tz, 6), tz)}</span>
            <Button onClick={() => setStart(startOfLocalDay(start, tz, 7))} aria-label="Tuần sau">›</Button>
            <Button onClick={() => setStart(weekStart(Date.now(), tz))}>Tuần này</Button>
          </>
        )}
        <Button onClick={load} className="ml-auto">Tải lại</Button>
      </div>
      <ErrorText error={error} />
      {view === "week" ? (
        <WeekCalendar start={start} rows={rows} onChanged={load} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">Không có bài nào khớp bộ lọc.</p>
      ) : (
        <div className="space-y-2">{rows.map((t) => <TargetItem key={t.id} target={t} onChanged={load} />)}</div>
      )}
    </section>
  );
}
