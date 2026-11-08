import { useEffect, useState, type DragEvent } from "react";
import { api } from "../api";
import { Button, ErrorText, FileButton, inputClass } from "./ui";

const ACCEPTED = ["image/jpeg", "image/png"];

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
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  useEffect(() => {
    if (!value.file) return setObjectUrl(null);
    const url = URL.createObjectURL(value.file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value.file]);
  // Thả trượt ra ngoài khung thì trình duyệt mở ảnh trong tab và mất nội dung form đang soạn: chặn việc đó.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    addEventListener("dragover", stop);
    addEventListener("drop", stop);
    return () => (removeEventListener("dragover", stop), removeEventListener("drop", stop));
  }, []);
  const src = previewSrc(value, objectUrl);
  const pickFile = (file: File | null) => (setDropError(null), onChange({ file, imageKey: null, imageUrl: "" }));

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) return setDropError(`"${file.name}" không phải ảnh JPEG/PNG`);
    pickFile(file);
  }
  // Rời vào phần tử con của vùng thả cũng phát dragleave: chỉ tắt viền khi thật sự ra khỏi vùng.
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false);

  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="mb-1 font-medium">Ảnh (JPEG ≤4MB, PNG ≤1MB; ảnh mới lưu vào thư mục post-fb trên Google Drive)</legend>
      <div
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex flex-wrap items-center gap-2 rounded border-2 border-dashed p-3 ${dragging ? "border-blue-600 bg-blue-50" : "border-gray-300"}`}
      >
        <FileButton label="Tải ảnh từ máy" accept={ACCEPTED.join(",")} file={value.file} onChange={pickFile} />
        <span className="text-gray-500">{dragging ? "Thả ảnh vào đây" : "hoặc kéo thả ảnh vào khung này"}</span>
        <Button type="button" onClick={() => setShowDrive(!showDrive)} aria-expanded={showDrive}>
          {showDrive ? "Đóng Google Drive" : "Chọn từ Google Drive"}
        </Button>
        {src && <Button type="button" onClick={() => onChange({ file: null, imageKey: null, imageUrl: "" })}>Bỏ ảnh</Button>}
      </div>
      <ErrorText error={dropError} />
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
