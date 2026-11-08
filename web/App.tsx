import { useCallback, useEffect, useState } from "react";
import { api, type Destinations, type Post } from "./api";
import { Accounts } from "./components/Accounts";
import { Dashboard } from "./components/Dashboard";
import { ImportCsv } from "./components/ImportCsv";
import { PostForm } from "./components/PostForm";
import { PostList } from "./components/PostList";
import { Slots } from "./components/Slots";
import { Button, ErrorText } from "./components/ui";

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
  const [posts, setPosts] = useState<Post[]>([]);
  const [dest, setDest] = useState<Destinations>({ accounts: [] });
  const [editing, setEditing] = useState<Post | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([api<Post[]>("/posts"), api<Destinations>("/accounts")])
      .then(([p, d]) => (setPosts(p), setDest(d)))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api<{ email: string }>("/me").then((d) => setEmail(d.email), (e: Error) => setError(e.message));
    reload();
  }, [reload]);

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex items-center justify-between border-b pb-3">
        <h1 className="text-xl font-semibold">post-fb</h1>
        <span className="text-sm text-gray-600">{email}</span>
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
          <PostList posts={posts} dest={dest} onEdit={setEditing} onChanged={reload} />
        </section>
      )}
      {tab === "dashboard" && <Dashboard />}
      {tab === "import" && <ImportCsv onImported={reload} />}
      {tab === "slots" && <Slots />}
      {tab === "accounts" && <Accounts dest={dest} onChanged={reload} />}
    </main>
  );
}
