import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCron } from "../src/jobs/cron";
import { decryptToken, encryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { seed } from "./helpers";

const TOKEN_URL = "POST https://api.pinterest.test/v5/oauth/token";
const DAY = 86_400_000;
const now = Date.now();

async function setPinterest(expiresInMs: number) {
  await env.DB.prepare("UPDATE accounts SET access_token_enc = ?, refresh_token_enc = ?, access_expires_at = ? WHERE id = 2")
    .bind(await encryptToken("pina_old", env.TOKEN_ENC_KEY), await encryptToken("pinr_old", env.TOKEN_ENC_KEY), now + expiresInMs)
    .run();
}

const account = () => env.DB.prepare("SELECT * FROM accounts WHERE id = 2").first<Record<string, string | number>>();

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());

it("refreshes a token expiring within 3 days and stores the rotated refresh token", async () => {
  await setPinterest(2 * DAY);
  const calls = mockFetch({
    [TOKEN_URL]: () => Response.json({ access_token: "pina_new", refresh_token: "pinr_new", expires_in: 2592000, refresh_token_expires_in: 5184000 }),
  });
  await runCron(env, now);
  expect(Object.fromEntries(await calls[0]!.formData())).toEqual({ grant_type: "refresh_token", refresh_token: "pinr_old" });
  const row = await account();
  expect(await decryptToken(String(row!.access_token_enc), env.TOKEN_ENC_KEY)).toBe("pina_new");
  expect(await decryptToken(String(row!.refresh_token_enc), env.TOKEN_ENC_KEY)).toBe("pinr_new");
  expect(row!.access_expires_at).toBe(now + 2592000_000);
});

it("leaves tokens with more than 3 days left alone", async () => {
  await setPinterest(10 * DAY);
  const calls = mockFetch({});
  await runCron(env, now);
  expect(calls).toHaveLength(0);
});

it("marks the account needs_reauth on 401, but keeps it ok on a 5xx", async () => {
  await setPinterest(DAY);
  mockFetch({ [TOKEN_URL]: () => Response.json({ code: 500, message: "boom" }, { status: 503 }) });
  await runCron(env, now);
  expect((await account())!.status).toBe("ok");

  vi.restoreAllMocks();
  mockFetch({ [TOKEN_URL]: () => Response.json({ code: 2, message: "Authentication failed." }, { status: 401 }) });
  await runCron(env, now);
  expect((await account())!.status).toBe("needs_reauth");
});
