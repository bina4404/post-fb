import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("first migration creates every table and enforces idempotency keys", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name <> '_cf_KV' ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual([
    "accounts",
    "app_settings",
    "boards",
    "oauth_states",
    "post_targets",
    "posts",
    "schedule_slots",
  ]);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, platform, external_id, name, updated_at) VALUES (1, 'facebook', 'p1', 'Page', ?)",
    ).bind(now),
    env.DB.prepare("INSERT INTO posts (id, caption, created_at, updated_at) VALUES (1, 'hi', ?, ?)").bind(now, now),
  ]);
  const target = env.DB.prepare(
    "INSERT INTO post_targets (post_id, platform, account_id, idempotency_key, updated_at) VALUES (1, 'facebook', 1, '1:facebook:1:0', ?)",
  ).bind(now);
  await target.run();
  await expect(target.run()).rejects.toThrow(/UNIQUE/);
});
