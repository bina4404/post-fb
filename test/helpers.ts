import { env } from "cloudflare:test";
import { app } from "../src/app";
import { encryptToken } from "../src/lib/crypto";

const bypassEnv = { ...env, DEV_AUTH_BYPASS: "1" } as typeof env;

/** Gọi API như người dùng đã đăng nhập (bypass Access trên localhost). */
export function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  return app.request(
    `http://localhost/api${path}`,
    { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body },
    bypassEnv,
  );
}

/** Xoá sạch dữ liệu và tạo 1 Page FB + 1 Board Pinterest đang bật. */
export async function seed() {
  const now = Date.now();
  await env.DB.batch([
    ...["post_targets", "posts", "boards", "accounts", "schedule_slots", "oauth_states"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
    env.DB.prepare(
      "INSERT INTO accounts (id, platform, external_id, name, enabled, updated_at) VALUES (1, 'facebook', 'page1', 'My Page', 1, ?), (2, 'pinterest', 'me', 'Pin User', 1, ?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT INTO boards (id, account_id, external_id, name, enabled) VALUES (10, 2, 'b-ext-1', 'Recipes', 1), (11, 2, 'b-ext-2', 'Hidden', 0)",
    ),
  ]);
}

export async function count(table: string) {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

export const DRIVE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** Tài khoản Google Drive đã kết nối, access token còn hạn `expiresInMs`. */
export async function seedDrive(expiresInMs = 3_600_000) {
  await env.DB.prepare(
    "INSERT INTO accounts (id, platform, external_id, name, access_token_enc, refresh_token_enc, access_expires_at, enabled, updated_at) VALUES (3, 'google', 'me@gmail.com', 'me@gmail.com', ?, ?, ?, 1, ?)",
  )
    .bind(await encryptToken("ya29.ACCESS", env.TOKEN_ENC_KEY), await encryptToken("1//REFRESH", env.TOKEN_ENC_KEY), Date.now() + expiresInMs, Date.now())
    .run();
}
