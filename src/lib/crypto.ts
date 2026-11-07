// Mã hoá token OAuth bằng AES-GCM. Định dạng lưu: base64(iv 12 byte || ciphertext).
const IV_BYTES = 12;

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyBase64);
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY phải là 32 byte base64 (openssl rand -base64 32)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plain: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(keyBase64);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return toBase64(out);
}

export async function decryptToken(stored: string, keyBase64: string): Promise<string> {
  const bytes = fromBase64(stored);
  const key = await importKey(keyBase64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES));
  return new TextDecoder().decode(plain);
}
