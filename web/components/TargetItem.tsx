import { useState } from "react";
import { api, type TargetRow } from "../api";
import { formatHour, formatTime } from "../time";
import { Button, ErrorText, StatusBadge } from "./ui";

function platformUrl(t: TargetRow): string | null {
  if (!t.externalPostId) return null;
  return t.platform === "facebook"
    ? `https://www.facebook.com/${t.externalPostId}`
    : `https://www.pinterest.com/pin/${t.externalPostId}/`;
}

/** Một target trên dashboard: giờ, đích, trạng thái, lỗi, link bài trên nền tảng, nút Đăng lại. */
export function TargetItem({ target, compact, onChanged }: { target: TargetRow; compact?: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const url = platformUrl(target);
  const dest = target.platform === "pinterest" ? `Pinterest · ${target.boardName}` : `Facebook · ${target.destination}`;

  async function retry() {
    setError(null);
    try {
      await api(`/targets/${target.id}/retry`, { method: "POST" });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className={`space-y-1 rounded border bg-white p-2 text-sm ${target.needsAttention ? "border-red-400" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-500">
          {target.scheduledAt ? (compact ? formatHour(target.scheduledAt) : formatTime(target.scheduledAt)) : "Nháp"}
        </span>
        <StatusBadge status={target.status} />
        {target.needsAttention && <span className="text-xs font-semibold text-red-700">Cần xử lý</span>}
      </div>
      <p className="text-xs text-gray-600">{dest}</p>
      <p className={compact ? "line-clamp-2" : "line-clamp-3 whitespace-pre-line"}>{target.caption}</p>
      {target.lastError && <p className="text-xs text-red-700">Lỗi: {target.lastError}</p>}
      {target.accountStatus === "needs_reauth" && <p className="text-xs text-amber-700">Tài khoản cần kết nối lại</p>}
      {url && (
        <a className="text-xs text-blue-700 underline" href={url} target="_blank" rel="noreferrer">
          Xem bài ({target.externalPostId})
        </a>
      )}
      {target.status === "failed" && !target.externalPostId && <Button onClick={retry}>Đăng lại</Button>}
      <ErrorText error={error} />
    </div>
  );
}
