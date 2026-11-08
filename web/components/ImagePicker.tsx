import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, ErrorText, FileButton, inputClass } from "./ui";

/** Đúng một nguồn ảnh: file mới (upload lên Drive khi lưu), ảnh có sẵn trên Drive (imageKey), hoặc URL https. */
export type ImageChoice = { file: File | null; imageKey: string | null; imageUrl: string };
type DriveImage = { id: string; name: string; thumbnailLink?: string };

function DriveGallery({ selected, onPick }: { selected: string | null; onPick: (id: string) => void }) {
  const [images, setImages] = useState<DriveImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<DriveImage[]>("/media").then(setImages, (e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorText error={error} />;
  if (!images) return <p className="text-sm text-gray-500">Đang tải ảnh từ Google Drive…</p>;
  if (images.length === 0) return <p className="text-sm text-gray-500">Thư mục post-fb trên Drive chưa có ảnh nào.</p>;
  return (
    <ul className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto rounded border p-2 sm:grid-cols-5">
      {images.map((img) => (
        <li key={img.id}>
          <button
            type="button"
            onClick={() => onPick(img.id)}
            aria-pressed={selected === img.id}
            title={img.name}
            className={`block w-full overflow-hidden rounded border-2 ${selected === img.id ? "border-blue-600" : "border-transparent hover:border-gray-300"}`}
          >
            {/* thumbnailLink của Drive là link tạm; lỗi thì đọc ảnh qua Worker. */}
            <img
              src={img.thumbnailLink ?? `/api/media/${img.id}`}
              onError={(e) => (e.currentTarget.src = `/api/media/${img.id}`)}
              alt={img.name}
              className="aspect-square w-full object-cover"
              referrerPolicy="no-referrer"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}

function previewSrc(v: ImageChoice, objectUrl: string | null): string | null {
  if (v.file) return objectUrl;
  if (v.imageKey) return `/api/media/${v.imageKey}`;
  return v.imageUrl || null;
}

export function ImagePicker({ value, onChange }: { value: ImageChoice; onChange: (v: ImageChoice) => void }) {
  const [showDrive, setShowDrive] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!value.file) return setObjectUrl(null);
    const url = URL.createObjectURL(value.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value.file]);
  const src = previewSrc(value, objectUrl);

  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="mb-1 font-medium">Ảnh (JPEG ≤4MB, PNG ≤1MB; ảnh mới lưu vào thư mục post-fb trên Google Drive)</legend>
      <div className="flex flex-wrap items-center gap-2">
        <FileButton label="Tải ảnh từ máy" accept="image/jpeg,image/png" file={value.file} onChange={(file) => onChange({ file, imageKey: null, imageUrl: "" })} />
        <Button type="button" onClick={() => setShowDrive(!showDrive)} aria-expanded={showDrive}>
          {showDrive ? "Đóng Google Drive" : "Chọn từ Google Drive"}
        </Button>
        {src && <Button type="button" onClick={() => onChange({ file: null, imageKey: null, imageUrl: "" })}>Bỏ ảnh</Button>}
      </div>
      {showDrive && <DriveGallery selected={value.imageKey} onPick={(imageKey) => (onChange({ file: null, imageKey, imageUrl: "" }), setShowDrive(false))} />}
      <input
        className={inputClass}
        type="url"
        placeholder="…hoặc dán URL ảnh https"
        aria-label="URL ảnh"
        value={value.imageUrl}
        onChange={(e) => onChange({ file: null, imageKey: null, imageUrl: e.target.value })}
      />
      {src && <img src={src} alt="Ảnh đã chọn" className="h-32 w-32 rounded border object-cover" />}
    </fieldset>
  );
}
