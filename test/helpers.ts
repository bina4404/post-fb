import { env } from "cloudflare:test";
import { app } from "../src/app";

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
