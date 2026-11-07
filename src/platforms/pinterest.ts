// Adapter duy nhất gọi Pinterest API v5. Tài liệu: developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization
import type { WorkerEnv } from "../env";
import { fetchWithTimeout, platformError, type ErrorKind } from "./errors";

export type PinterestConfig = { appId: string; appSecret: string; apiBase: string };
export type PinterestTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
};

export const pinterestConfig = (env: WorkerEnv): PinterestConfig => ({
  appId: env.PINTEREST_APP_ID,
  appSecret: env.PINTEREST_APP_SECRET,
  apiBase: env.PINTEREST_API_BASE,
});

export const PINTEREST_SCOPES = ["boards:read", "pins:write", "user_accounts:read"];

function classify(status: number): ErrorKind {
  if (status === 401) return "auth";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

async function call<T>(op: string, url: string, init: RequestInit): Promise<T> {
  const res = await fetchWithTimeout("pinterest", op, url, init);
  const body = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!res.ok) {
    throw platformError("pinterest", op, classify(res.status), res.status, body.code ?? null, body.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export function authorizeUrl(cfg: PinterestConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: PINTEREST_SCOPES.join(","),
    state,
  });
  return `https://www.pinterest.com/oauth/?${params}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
};

async function tokenRequest(cfg: PinterestConfig, op: string, form: Record<string, string>, now: number) {
  const res = await call<TokenResponse>(op, `${cfg.apiBase}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${cfg.appId}:${cfg.appSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    accessExpiresAt: now + res.expires_in * 1000,
    refreshExpiresAt: res.refresh_token_expires_in ? now + res.refresh_token_expires_in * 1000 : null,
  };
}

export async function exchangeCode(cfg: PinterestConfig, redirectUri: string, code: string, now: number): Promise<PinterestTokens> {
  const t = await tokenRequest(cfg, "exchange_code", { grant_type: "authorization_code", code, redirect_uri: redirectUri }, now);
  if (!t.refreshToken) throw platformError("pinterest", "exchange_code", "permanent", 200, null, "missing refresh_token");
  return { ...t, refreshToken: t.refreshToken };
}

/** Pinterest trả refresh token mới sau mỗi lần refresh (continuous refresh), luôn lưu đè. */
export async function refreshTokens(cfg: PinterestConfig, refreshToken: string, now: number): Promise<PinterestTokens> {
  const t = await tokenRequest(cfg, "refresh_token", { grant_type: "refresh_token", refresh_token: refreshToken }, now);
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

export async function getUsername(cfg: PinterestConfig, token: string): Promise<string> {
  return (await call<{ username: string }>("user_account", `${cfg.apiBase}/user_account`, bearer(token))).username;
}

export async function listBoards(cfg: PinterestConfig, token: string): Promise<{ id: string; name: string }[]> {
  const boards: { id: string; name: string }[] = [];
  let bookmark: string | null = null;
  do {
    const params = new URLSearchParams({ page_size: "250", ...(bookmark ? { bookmark } : {}) });
    const page: { items: { id: string; name: string }[]; bookmark: string | null } = await call(
      "list_boards",
      `${cfg.apiBase}/boards?${params}`,
      bearer(token),
    );
    boards.push(...page.items.map((b) => ({ id: b.id, name: b.name })));
    bookmark = page.bookmark;
  } while (bookmark);
  return boards;
}

export type PinImage = { bytes: Uint8Array; contentType: string };
export type Pin = { boardId: string; description: string; link: string | null; image: PinImage };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Theo từng khối để không vượt giới hạn số đối số của String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** POST /v5/pins với ảnh dạng base64. Trả về id của Pin. */
export async function createPin(cfg: PinterestConfig, token: string, pin: Pin): Promise<string> {
  const body = {
    board_id: pin.boardId,
    description: pin.description,
    ...(pin.link ? { link: pin.link } : {}),
    media_source: { source_type: "image_base64", content_type: pin.image.contentType, data: toBase64(pin.image.bytes) },
  };
  const res = await call<{ id: string }>("create_pin", `${cfg.apiBase}/pins`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.id;
}
