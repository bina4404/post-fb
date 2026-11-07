import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { TargetStatus } from "../api";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}

export const inputClass = "w-full rounded border border-gray-300 px-2 py-1";

const STATUS_COLOR: Record<TargetStatus, string> = {
  draft: "bg-gray-200 text-gray-700",
  scheduled: "bg-blue-100 text-blue-800",
  publishing: "bg-amber-100 text-amber-800",
  published: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: TargetStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[status]}`}>{status}</span>;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null;
}
