// Adapter duy nhất gọi Meta Graph API. Tài liệu: developers.facebook.com/docs/pages-api, .../access-tokens/get-long-lived
import type { WorkerEnv } from "../env";
import { log } from "../lib/log";
import { fetchWithTimeout, platformError, type ErrorKind } from "./errors";

export type FacebookConfig = { appId: string; appSecret: string; version: string };
export type FacebookPage = { id: string; name: string; accessToken: string };

export const facebookConfig = (env: WorkerEnv): FacebookConfig => ({
  appId: env.FB_APP_ID,
  appSecret: env.FB_APP_SECRET,
  version: env.GRAPH_API_VERSION,
});

export const FACEBOOK_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

type GraphError = { message?: string; code?: number; is_transient?: boolean };
// Mã lỗi tạm thời theo Graph API (lỗi không xác định, dịch vụ, giới hạn rate).
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

function classify(status: number, error: GraphError | undefined): ErrorKind {
  if (error?.code === 190) return "auth";
  if (error?.is_transient || TRANSIENT_CODES.has(error?.code ?? -1) || status === 429 || status >= 500) return "transient";
  return "permanent";
}

async function graph<T>(op: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout("facebook", op, url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: GraphError };
  if (!res.ok || body.error) {
    const e = body.error;
    throw platformError("facebook", op, classify(res.status, e), res.status, e?.code ?? null, e?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

const graphUrl = (cfg: FacebookConfig, path: string, params: Record<string, string>) =>
  `https://graph.facebook.com/${cfg.version}/${path}?${new URLSearchParams(params)}`;

export function authorizeUrl(cfg: FacebookConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: redirectUri,
    state,
    scope: FACEBOOK_SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${cfg.version}/dialog/oauth?${params}`;
}

/** code → user token ngắn hạn → user token dài hạn (~60 ngày). */
export async function exchangeCode(cfg: FacebookConfig, redirectUri: string, code: string): Promise<string> {
  const creds = { client_id: cfg.appId, client_secret: cfg.appSecret };
  const short = await graph<{ access_token: string }>(
    "exchange_code",
    graphUrl(cfg, "oauth/access_token", { ...creds, redirect_uri: redirectUri, code }),
  );
  const long = await graph<{ access_token: string }>(
    "long_lived_token",
    graphUrl(cfg, "oauth/access_token", { ...creds, grant_type: "fb_exchange_token", fb_exchange_token: short.access_token }),
  );
  return long.access_token;
}

/** Các Page người dùng được phép đăng bài. Page token lấy từ user token dài hạn thì không hết hạn. */
export async function listPages(cfg: FacebookConfig, userToken: string): Promise<FacebookPage[]> {
  // shortcut: lấy tối đa 100 Page, không theo trang tiếp; đủ cho 1–5 người dùng.
  const res = await graph<{ data: { id: string; name: string; access_token: string; tasks?: string[] }[]; paging?: { next?: string } }>(
    "list_pages",
    graphUrl(cfg, "me/accounts", { fields: "id,name,access_token,tasks", limit: "100", access_token: userToken }),
  );
  const postable = res.data.filter((p) => !p.tasks || p.tasks.includes("CREATE_CONTENT"));
  // Ghi lại Page nào Facebook trả về và Page nào bị bỏ qua vì thiếu quyền tạo nội dung (không log token).
  log("info", "facebook_pages_listed", {
    returned: res.data.length,
    postable: postable.length,
    hasNextPage: Boolean(res.paging?.next),
    pages: res.data.map((p) => `${p.name} [${p.tasks?.join("|") ?? "no tasks"}]`).join("; "),
  });
  return postable.map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token }));
}

export type Image = { bytes: Uint8Array; contentType: string };
export type FacebookPost = { caption: string; link: string | null; image: Image | null };

/**
 * Đăng lên Page. Có ảnh: POST /{page-id}/photos (multipart `source`, `caption`). /photos không có tham số link,
 * nên link được nối vào cuối caption. Không ảnh: POST /{page-id}/feed (`message`, `link`).
 * Trả về id bài đăng của Page (`post_id` của ảnh, hoặc `id` của feed).
 */
export async function publishPost(cfg: FacebookConfig, pageId: string, pageToken: string, post: FacebookPost): Promise<string> {
  const base = `https://graph.facebook.com/${cfg.version}/${pageId}`;
  if (post.image) {
    const form = new FormData();
    form.set("source", new Blob([post.image.bytes], { type: post.image.contentType }), "image");
    form.set("caption", post.link ? `${post.caption}\n\n${post.link}` : post.caption);
    form.set("published", "true");
    form.set("access_token", pageToken);
    const res = await graph<{ id: string; post_id?: string }>("publish_photo", `${base}/photos`, { method: "POST", body: form });
    return res.post_id ?? res.id;
  }
  const body = new URLSearchParams({ message: post.caption, access_token: pageToken, ...(post.link ? { link: post.link } : {}) });
  return (await graph<{ id: string }>("publish_feed", `${base}/feed`, { method: "POST", body })).id;
}
