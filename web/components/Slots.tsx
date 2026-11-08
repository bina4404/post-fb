import { useCallback, useEffect, useState } from "react";
import { api, type Slot } from "../api";
import { WEEKDAYS } from "../time";
import { Button, ErrorText, inputClass } from "./ui";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function Slots() {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Slot[]>("/slots").then(setSlots, (e: Error) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  async function run(promise: Promise<unknown>) {
    setError(null);
    try {
      await promise;
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const [h = 0, m = 0] = time.split(":").map(Number);
  return (
    <section className="space-y-3 rounded border bg-white p-4">
      <p className="text-sm text-gray-600">Khung giờ lặp lại hằng tuần, tính theo múi giờ đang chọn ở góc trên. "Xếp vào khung giờ" lấy khung trống sớm nhất.</p>
      <div className="flex items-center gap-2">
        <select className={`${inputClass} w-auto`} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} aria-label="Thứ">
          {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
        </select>
        <input className={`${inputClass} w-auto`} type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Giờ" />
        <Button onClick={() => run(api("/slots", { method: "POST", json: { weekday, minuteOfDay: h * 60 + m } }))}>Thêm</Button>
      </div>
      <ErrorText error={error} />
      <ul className="flex flex-wrap gap-2">
        {slots.map((s) => (
          <li key={s.id} className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-sm">
            {WEEKDAYS[s.weekday]} {hhmm(s.minuteOfDay)}
            <button aria-label="Xoá khung giờ" className="text-red-700" onClick={() => run(api(`/slots/${s.id}`, { method: "DELETE" }))}>×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
