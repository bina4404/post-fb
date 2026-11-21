import { useEffect, useState } from "react";
import { api } from "../api";
import { formatTime, useTz } from "../time";
import { ErrorText, inputClass } from "./ui";

const METRICS = {
  page_media_view: "Lượt xem",
  page_post_engagements: "Tương tác",
  page_daily_follows_unique: "Theo dõi mới",
  page_daily_unfollows_unique: "Bỏ theo dõi",
  page_video_views: "Lượt xem video",
  page_views_total: "Lượt xem trang",
} as const;
type Metric = keyof typeof METRICS;
type Totals = Record<Metric, number>;
type Overview = { pages: { id: number; name: string; followers: number | null; totals: Totals | null; error: string | null }[] };
type Post = { id: string; message: string; createdTime: string; permalink: string | null; picture: string | null; views: number; viewers: number; clicks: number; reactions: number; comments: number; shares: number };
type Detail = { followers: number | null; daily: Partial<Record<Metric, { date: string; value: number }[]>>; totals: Totals; posts: Post[] };

const RANGES = [7, 28, 90] as const;
const SORTS = {
  views: { label: "Lượt xem", value: (p: Post) => p.views },
  engagement: { label: "Tương tác (cảm xúc + bình luận + chia sẻ)", value: (p: Post) => p.reactions + p.comments + p.shares },
  clicks: { label: "Lượt nhấp", value: (p: Post) => p.clicks },
} as const;
const num = (n: number | null | undefined) => (n == null ? "–" : new Intl.NumberFormat("vi-VN").format(n));

/** Cột theo ngày của một chỉ số (một chuỗi số liệu nên không cần chú thích; di chuột vào cột để xem số). */
function DailyBars({ label, points }: { label: string; points: { date: string; value: number }[] }) {
  const W = 720;
  const H = 160;
  const max = Math.max(1, ...points.map((p) => p.value));
  const slot = W / Math.max(1, points.length);
  return (
    <figure className="space-y-1">
      <figcaption className="text-sm font-medium">{label} theo ngày</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label={`${label} theo ngày, cao nhất ${num(max)}`}>
        <text x={0} y={10} className="fill-gray-500 text-[10px]">{num(max)}</text>
        <line x1={0} x2={W} y1={H} y2={H} className="stroke-gray-300" />
        {points.map((p, i) => {
          const h = (p.value / max) * (H - 16);
          return (
            <g key={p.date}>
              {/* Vùng di chuột cao hết cột, rộng hơn thanh, để dễ trỏ vào. */}
              <rect x={i * slot} y={0} width={slot} height={H} className="fill-transparent hover:fill-gray-100">
                <title>{`${p.date}: ${num(p.value)}`}</title>
              </rect>
              <rect x={i * slot + 1} y={H - h} width={Math.max(1, slot - 2)} height={h} rx={2} className="pointer-events-none fill-blue-600" />
            </g>
          );
        })}
        <text x={0} y={H + 14} className="fill-gray-500 text-[10px]">{points[0]?.date}</text>
        <text x={W} y={H + 14} textAnchor="end" className="fill-gray-500 text-[10px]">{points.at(-1)?.date}</text>
      </svg>
      <details className="text-sm">
        <summary className="cursor-pointer text-blue-700">Xem dạng bảng</summary>
        <table className="mt-1 text-xs">
          <tbody>{points.map((p) => <tr key={p.date}><td className="pr-4">{p.date}</td><td className="text-right">{num(p.value)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

function TopContent({ posts }: { posts: Post[] }) {
  const tz = useTz();
  const [sort, setSort] = useState<keyof typeof SORTS>("views");
  const ranked = [...posts].sort((a, b) => SORTS[sort].value(b) - SORTS[sort].value(a)).slice(0, 20);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Nội dung hàng đầu</h3>
        <select className={`${inputClass} w-auto`} aria-label="Xếp hạng theo" value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)}>
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>Theo {s.label.toLowerCase()}</option>)}
        </select>
        <span className="text-xs text-gray-500">({posts.length} bài trong khoảng này; tương tác trên Reels có thể không được Facebook tính)</span>
      </div>
      {ranked.length === 0 && <p className="text-sm text-gray-500">Không có bài nào trong khoảng này.</p>}
      <ol className="space-y-2">
        {ranked.map((p, i) => (
          <li key={p.id} className="flex gap-3 rounded border bg-white p-2 text-sm">
            <span className="w-6 shrink-0 text-right font-semibold text-gray-500">{i + 1}</span>
            {p.picture ? <img src={p.picture} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded object-cover" /> : <div className="h-16 w-16 shrink-0 rounded bg-gray-100" />}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="line-clamp-2">{p.message || <span className="text-gray-500">(không có chữ)</span>}</p>
              <p className="text-xs text-gray-600">
                {formatTime(Date.parse(p.createdTime), tz)} · {num(p.views)} lượt xem · {num(p.viewers)} người xem · {num(p.reactions)} cảm xúc · {num(p.comments)} bình luận ·{" "}
                {num(p.shares)} chia sẻ · {num(p.clicks)} lượt nhấp
              </p>
              {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" className="text-xs text-blue-700 underline">Xem trên Facebook</a>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PageDetail({ pageId, days }: { pageId: number; days: number }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("page_media_view");
  useEffect(() => {
    setData(null);
    setError(null);
    api<Detail>(`/insights/${pageId}?days=${days}`).then(setData, (e: Error) => setError(e.message));
  }, [pageId, days]);
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="text-sm text-gray-500">Đang tải số liệu từ Facebook…</p>;
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Biểu đồ</span>
        <select className={`${inputClass} w-auto`} value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {Object.entries(METRICS).map(([k, label]) => <option key={k} value={k}>{label} ({num(data.totals[k as Metric])})</option>)}
        </select>
      </label>
      <DailyBars label={METRICS[metric]} points={data.daily[metric] ?? []} />
      <TopContent posts={data.posts} />
    </div>
  );
}

export function Insights() {
  const [days, setDays] = useState<number>(28);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    setData(null);
    api<Overview>(`/insights?days=${days}`).then(setData, (e: Error) => setError(e.message));
  }, [days]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-gray-600">Khoảng thời gian:</span>
        {RANGES.map((d) => (
          <button key={d} onClick={() => setDays(d)} className={days === d ? "font-semibold text-blue-700" : "text-gray-600"}>{d} ngày</button>
        ))}
        <span className="text-xs text-gray-500">Số liệu lấy trực tiếp từ Facebook, thường cập nhật mỗi ngày một lần.</span>
      </div>
      <ErrorText error={error} />
      {!data && !error && <p className="text-sm text-gray-500">Đang tải số liệu từ Facebook…</p>}
      {data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-600">
                <th className="py-1 pr-3 font-medium">Page</th>
                <th className="py-1 pr-3 text-right font-medium">Người theo dõi</th>
                {Object.values(METRICS).map((label) => <th key={label} className="py-1 pr-3 text-right font-medium">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.pages.map((p) => (
                <tr key={p.id} className={`border-b ${selected === p.id ? "bg-blue-50" : ""}`}>
                  <td className="py-1 pr-3">
                    <button className="text-left text-blue-700 underline" onClick={() => setSelected(p.id)}>{p.name}</button>
                  </td>
                  {p.error ? (
                    <td colSpan={7} className="py-1 pr-3 text-red-700">{p.error}</td>
                  ) : (
                    <>
                      <td className="py-1 pr-3 text-right">{num(p.followers)}</td>
                      {(Object.keys(METRICS) as Metric[]).map((m) => <td key={m} className="py-1 pr-3 text-right">{num(p.totals?.[m])}</td>)}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data.pages.length === 0 && <p className="text-sm text-gray-500">Chưa có Page nào được bật (tab Tài khoản).</p>}
        </div>
      )}
      {selected !== null && (
        <section className="space-y-3 rounded border bg-white p-3">
          <h2 className="font-semibold">{data?.pages.find((p) => p.id === selected)?.name} · {days} ngày qua</h2>
          <PageDetail pageId={selected} days={days} />
        </section>
      )}
    </section>
  );
}
