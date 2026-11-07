import { useState } from "react";
import { api, type Account, type Destinations } from "../api";
import { Button, ErrorText } from "./ui";

type Props = { dest: Destinations; onChanged: () => void };

const SECTIONS = [
  { platform: "facebook", title: "Facebook Pages", button: "Facebook", hint: "Tick để chọn Page được dùng khi đăng bài." },
  { platform: "pinterest", title: "Pinterest", button: "Pinterest", hint: "Tick để chọn tài khoản và Board được dùng khi đăng bài." },
  { platform: "google", title: "Google Drive (lưu ảnh)", button: "Google Drive", hint: "Ảnh upload được lưu vào Drive của tài khoản này. Bắt buộc kết nối trước khi upload ảnh." },
] as const;

// Lỗi OAuth được callback trả về qua hash: #/accounts?error=...
const oauthError = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("error");

function AccountRow({ account, dest, run }: { account: Account; dest: Destinations; run: (p: Promise<unknown>) => void }) {
  const boards = dest.boards.filter((b) => b.accountId === account.id);
  return (
    <li className="space-y-2 rounded border bg-white p-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Google Drive chỉ để lưu ảnh, không phải đích đăng bài nên không có ô chọn. */}
        {account.platform === "google" ? (
          <span className="font-medium">{account.name}</span>
        ) : (
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={account.enabled}
              onChange={(e) => run(api(`/accounts/${account.id}`, { method: "PATCH", json: { enabled: e.target.checked } }))}
            />
            {account.name}
          </label>
        )}
        {account.status === "needs_reauth" && <span className="text-sm text-red-700">Cần kết nối lại</span>}
        <Button className="ml-auto" onClick={() => confirm(`Ngắt kết nối ${account.name}?`) && run(api(`/accounts/${account.id}/disconnect`, { method: "POST" }))}>
          Ngắt kết nối
        </Button>
      </div>
      {boards.length > 0 && (
        <ul className="flex flex-wrap gap-3 pl-6 text-sm">
          {boards.map((b) => (
            <li key={b.id}>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={b.enabled} onChange={(e) => run(api(`/boards/${b.id}`, { method: "PATCH", json: { enabled: e.target.checked } }))} />
                {b.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Accounts({ dest, onChanged }: Props) {
  const [error, setError] = useState<string | null>(oauthError);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.then(onChanged, (e: Error) => setError(e.message));
  };

  return (
    <section className="space-y-4">
      <ErrorText error={error} />
      {SECTIONS.map(({ platform, title, button, hint }) => (
        <div key={platform} className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{title}</h2>
            <a className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700" href={`/api/oauth/${platform}/start`}>
              Kết nối {button}
            </a>
          </div>
          <p className="text-xs text-gray-500">{hint}</p>
          <ul className="space-y-2">
            {dest.accounts.filter((a) => a.platform === platform).map((a) => (
              <AccountRow key={a.id} account={a} dest={dest} run={run} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
