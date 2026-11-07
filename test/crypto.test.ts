import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/lib/crypto";

it("round-trips a token and uses a fresh IV every time", async () => {
  const a = await encryptToken("EAAG-secret", env.TOKEN_ENC_KEY);
  const b = await encryptToken("EAAG-secret", env.TOKEN_ENC_KEY);
  expect(a).not.toBe(b);
  expect(a).not.toContain("EAAG");
  expect(await decryptToken(a, env.TOKEN_ENC_KEY)).toBe("EAAG-secret");
});

it("fails with the wrong key or tampered data", async () => {
  const enc = await encryptToken("tok", env.TOKEN_ENC_KEY);
  const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  await expect(decryptToken(enc, otherKey)).rejects.toThrow();
  const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
  await expect(decryptToken(tampered, env.TOKEN_ENC_KEY)).rejects.toThrow();
});

it("rejects a key that is not 32 bytes", async () => {
  await expect(encryptToken("tok", btoa("short"))).rejects.toThrow(/32 byte/);
});
