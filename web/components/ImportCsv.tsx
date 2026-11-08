import { useState } from "react";
import { api, ApiError } from "../api";
import { Button, ErrorText, FileButton } from "./ui";

type LineError = { line: number; message: string };

export function ImportCsv({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<LineError[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  async function upload() {
    if (!file) return;
    setErrors([]);
    setError(null);
    setDone(null);
    try {
      const res = await api<{ imported: number }>("/import", { method: "POST", body: await file.text() });
      setDone(res.imported);
      onImported();
    } catch (err) {
      if (err instanceof ApiError && err.body.errors) setErrors(err.body.errors);
      else setError((err as Error).message);
    }
  }

  return (
    <section className="space-y-3 rounded border bg-white p-4">
      <p className="text-sm text-gray-600">
        Cột: <code>caption,link,image_url,scheduled_at</code>. Bài đăng lên Page Facebook duy nhất đang bật. <code>scheduled_at</code>{" "}
        theo ISO 8601, không có offset thì hiểu là giờ Bangkok, để trống = nháp. Có một dòng lỗi thì không dòng nào được import.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <FileButton label="Chọn file CSV" accept=".csv,text/csv" file={file} onChange={setFile} />
        <Button variant="primary" disabled={!file} onClick={upload}>Import</Button>
      </div>
      {done !== null && <p className="text-sm text-green-700">Đã import {done} bài.</p>}
      <ErrorText error={error} />
      {errors.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-red-700">
          {errors.map((e, i) => <li key={i}>Dòng {e.line}: {e.message}</li>)}
        </ul>
      )}
    </section>
  );
}
