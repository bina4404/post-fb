import { useCallback, useEffect, useState } from "react";
import { api, type Destinations, type Post } from "./api";
import { Accounts } from "./components/Accounts";
import { Dashboard } from "./components/Dashboard";
import { ImportCsv } from "./components/ImportCsv";
import { PostForm } from "./components/PostForm";
import { Library } from "./components/Library";
import { Slots } from "./components/Slots";
import { Button, ErrorText, inputClass } from "./components/ui";
import { loadTz, saveTz, TIME_ZONES, TzContext, type TimeZone } from "./time";

const TABS = { dashboard: "Lịch đăng", library: "Thư viện", import: "Import CSV", slots: "Khung giờ", accounts: "Tài khoản" } as const;
type Tab = keyof typeof TABS;

function useHashTab(): Tab {
  const read = () => {
    const name = location.hash.replace("#/", "").split("?")[0]!;
    return (name in TABS ? name : "dashboard") as Tab;
  };
  const [tab, setTab] = useState(read);
  useEffect(() => {
    const onHash = () => setTab(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return tab;
}

export function App() {
  const tab = useHashTab();
  const [email, setEmail] = useState("");
  const [libraryKey, setLibraryKey] = useState(0);
  const [dest, setDest] = useState<Destinations>({ accounts: [] });
  const [editing, setEditing] = useState<Post | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tz, setTz] = useState<TimeZone>(loadTz);
  // Múi giờ lưu chung trên server; bản trong trình duyệt chỉ để hiện đúng ngay lúc mở trang.
  const applyTz = (value: TimeZone) => (setTz(value), saveTz(value));
  const changeTz = (value: TimeZone) => {
    applyTz(value);
    api("/settings", { method: "PUT", json: { timeZone: value } }).catch((e: Error) => setError(`Không lưu được múi giờ: ${e.message}`));
  };

  const reload = useCallback(() => {
    setLibraryKey((n) => n + 1);
    api<Destinations>("/accounts").then(setDest, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api<{ email: string }>("/me").then((d) => setEmail(d.email), (e: Error) => setError(e.message));
    api<{ timeZone: TimeZone }>("/settings").then((d) => applyTz(d.timeZone), () => undefined);
    reload();
  }, [reload]);

  return (
    <TzContext.Provider value={tz}>
    <main className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <h1 className="text-xl font-semibold">post-fb</h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-600">Múi giờ</span>
            <select className={`${inputClass} w-auto`} value={tz} onChange={(e) => changeTz(e.target.value as TimeZone)}>
              {TIME_ZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
          </label>
          <span className="text-sm text-gray-600">{email}</span>
        </div>
      </header>
      <nav className="flex gap-4 text-sm">
        {Object.entries(TABS).map(([key, label]) => (
          <a key={key} href={`#/${key}`} className={tab === key ? "font-semibold text-blue-700" : "text-gray-600"}>{label}</a>
        ))}
      </nav>
      <ErrorText error={error} />
      {tab === "library" && (
        <section className="space-y-3">
          {editing ? (
            <PostForm
              key={editing === "new" ? "new" : editing.id}
              post={editing === "new" ? undefined : editing}
              dest={dest}
              onSaved={() => (setEditing(null), reload())}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Button variant="primary" onClick={() => setEditing("new")}>+ Tạo bài mới</Button>
          )}
          <Library dest={dest} reloadKey={libraryKey} onEdit={setEditing} onChanged={() => api<Destinations>("/accounts").then(setDest, () => undefined)} />
        </section>
      )}
      {tab === "dashboard" && <Dashboard />}
      {tab === "import" && <ImportCsv onImported={reload} />}
      {tab === "slots" && <Slots />}
      {tab === "accounts" && <Accounts dest={dest} onChanged={reload} />}
    </main>
    </TzContext.Provider>
  );
}
