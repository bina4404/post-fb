import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";

const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
});

function sign(aud: string) {
  return new SignJWT({ email: "me@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const me = (headers: Record<string, string>, bindings = env, host = "app.example.com") =>
  app.request(`https://${host}/api/me`, { headers }, bindings);

describe("Cloudflare Access middleware", () => {
  it("rejects a request without a JWT", async () => {
    expect((await me({})).status).toBe(403);
  });

  it("accepts a valid JWT and exposes the email", async () => {
    const res = await me({ "Cf-Access-Jwt-Assertion": await sign(env.ACCESS_AUD) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "me@example.com" });
  });

  it("rejects a JWT for another Access application", async () => {
    const res = await me({ "Cf-Access-Jwt-Assertion": await sign("other-aud") });
    expect(res.status).toBe(403);
  });

  it("rejects everything when Access is not configured", async () => {
    const res = await me(
      { "Cf-Access-Jwt-Assertion": await sign(env.ACCESS_AUD) },
      { ...env, ACCESS_AUD: "" },
    );
    expect(res.status).toBe(403);
  });

  it("ignores DEV_AUTH_BYPASS outside localhost", async () => {
    expect((await me({}, { ...env, DEV_AUTH_BYPASS: "1" } as typeof env)).status).toBe(403);
  });

  it("honours DEV_AUTH_BYPASS on localhost", async () => {
    const res = await me({}, { ...env, DEV_AUTH_BYPASS: "1" } as typeof env, "localhost:8787");
    expect(res.status).toBe(200);
  });
});
