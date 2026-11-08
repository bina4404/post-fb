import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { TargetStatus } from "../api";

const BUTTON = "rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-blue-600";
const VARIANTS = {
  default: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-100",
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  success: "bg-green-600 text-white hover:bg-green-700",
};
type Variant = keyof typeof VARIANTS;

export function Button({ className = "", variant = "default", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={`${BUTTON} ${VARIANTS[variant]} ${className}`} {...props} />;
}

/** Nút chọn file thay cho ô "Choose File" mặc định của trình duyệt; hiện tên file đã chọn. */
export function FileButton({ label, accept, file, onChange }: { label: string; accept: string; file: File | null; onChange: (f: File | null) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <label className={`${BUTTON} ${VARIANTS.default} cursor-pointer focus-within:outline-2 focus-within:outline-blue-600`}>
        {label}
        <input type="file" accept={accept} className="sr-only" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      </label>
      <span className="text-sm text-gray-600">{file ? file.name : "Chưa chọn file"}</span>
    </span>
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
