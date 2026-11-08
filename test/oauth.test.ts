import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken } from "../src/lib/crypto";
import { mockFetch } from "./fetch-mock";
import { api, seed } from "./helpers";

const GRAPH = "https://graph.facebook.com/v27.0";

async function start(platform: string) {
  const res = await api(`/oauth/${platform}/start`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  return { location, state: location.searchParams.get("state")! };
}

const callback = (platform: string, query: string) => api(`/oauth/${platform}/callback?${query}`);

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());

describe("OAuth state (CSRF)", () => {
  it("rejects an unknown, reused, expired or cross-platform state", async () => {
    expect((await callback("facebook", "state=nope&code=c")).status).toBe(400);

    const { state } = await start("facebook");
    expect((await callback("google", `state=${state}&code=c`)).status).toBe(400);

    mockFetch({
      [`GET ${GRAPH}/oauth/access_token`]: () => Response.json({ access_token: "user-token" }),
      [`GET ${GRAPH}/me/accounts`]: () => Response.json({ data: [] }),
    });
    expect((await callback("facebook", `state=${state}&code=c`)).status).toBe(302);
    expect((await callback("facebook", `state=${state}&code=c`)).status).toBe(400);

    const old = await start("facebook");
    await env.DB.prepare("UPDATE oauth_states SET created_at = 0 WHERE state = ?").bind(old.state).run();
    expect((await callback("facebook", `state=${old.state}&code=c`)).status).toBe(400);
  });
});

describe("Facebook", () => {
  it("redirects to the v27.0 dialog with the Page scopes", async () => {
    const { location } = await start("facebook");
    expect(location.origin + location.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(location.searchParams.get("scope")).toBe("pages_show_list,pages_read_engagement,pages_manage_posts,business_management");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/api/oauth/facebook/callback");
  });

  it("stores encrypted Page tokens for postable Pages, disabled until chosen", async () => {
    const { state } = await start("facebook");
    const calls = mockFetch({
      [`GET ${GRAPH}/oauth/access_token`]: (req) =>
        Response.json({ access_token: new URL(req.url).searchParams.has("fb_exchange_token") ? "long-user" : "short-user" }),
      [`GET ${GRAPH}/me/accounts`]: () =>
        Response.json({
          data: [
            { id: "p2", name: "Shop", access_token: "PAGE-TOKEN-2", tasks: ["CREATE_CONTENT", "MANAGE"] },
            { id: "p3", name: "Read only", access_token: "PAGE-TOKEN-3", tasks: ["ANALYZE"] },
          ],
        }),
    });
    const res = await callback("facebook", `state=${state}&code=the-code`);
    expect(res.headers.get("location")).toBe("/#/accounts");
    expect(new URL(calls[2]!.url).searchParams.get("access_token")).toBe("long-user");

    const row = await env.DB.prepare("SELECT * FROM accounts WHERE external_id = 'p2'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ name: "Shop", enabled: 0, status: "ok" });
    expect(row!.access_token_enc).not.toContain("PAGE-TOKEN");
    expect(await decryptToken(String(row!.access_token_enc), env.TOKEN_ENC_KEY)).toBe("PAGE-TOKEN-2");
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE external_id = 'p3'").first()).toBeNull();

    const listed = await (await api("/accounts")).text();
    expect(listed).not.toContain("token_enc");
    expect(listed).not.toContain("accessTokenEnc");
  });

  it("returns to the accounts page with the Graph error, without logging tokens", async () => {
    const { state } = await start("facebook");
    const logs = vi.spyOn(console, "log");
    mockFetch({
      [`GET ${GRAPH}/oauth/access_token`]: () =>
        Response.json({ error: { message: "Invalid verification code", code: 100 } }, { status: 400 }),
    });
    const res = await callback("facebook", `state=${state}&code=secret-code`);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Invalid verification code");
    const output = logs.mock.calls.flat().join("\n");
    expect(output).toContain('"event":"platform_error"');
    expect(output).not.toContain("secret-code");
    expect(output).not.toContain("fb-secret");
  });
});

describe("account management", () => {
  it("Pinterest is no longer a supported platform", async () => {
    expect((await api("/oauth/pinterest/start")).status).toBe(404);
  });

  it("enables a Page and disconnects an account without deleting it", async () => {
    expect((await api("/accounts/2", { method: "PATCH", json: { enabled: true } })).status).toBe(200);
    expect((await api("/accounts/1/disconnect", { method: "POST" })).status).toBe(204);
    const row = await env.DB.prepare("SELECT access_token_enc, enabled, status FROM accounts WHERE id = 1").first();
    expect(row).toEqual({ access_token_enc: null, enabled: 0, status: "needs_reauth" });
  });
});
