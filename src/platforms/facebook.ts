// Adapter duy nhất gọi Meta Graph API. Tài liệu: developers.facebook.com/docs/pages-api, .../access-tokens/get-long-lived
import type { WorkerEnv } from "../env";
import { log } from "../lib/log";
import type { VideoStream } from "./drive";
import { fetchWithTimeout, platformError, VIDEO_TIMEOUT_MS, type ErrorKind } from "./errors";

export type FacebookConfig = { appId: string; appSecret: string; version: string };
export type FacebookPage = { id: string; name: string; accessToken: string };

export const facebookConfig = (env: WorkerEnv): FacebookConfig => ({
  appId: env.FB_APP_ID,
  appSecret: env.FB_APP_SECRET,
  version: env.GRAPH_API_VERSION,
});

// business_management: không có quyền này, /me/accounts không trả về Page mà người dùng quản lý qua Business Portfolio.
// read_insights: xem thống kê Page và bài (tab Thống kê).
export const FACEBOOK_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "read_insights"];

type GraphError = { message?: string; code?: number; is_transient?: boolean };
// Mã lỗi Graph API: lỗi tạm thời của dịch vụ; vượt giới hạn gọi (app/user/Page/BUC); bị chặn vì nghi lạm dụng.
const TRANSIENT_CODES = new Set([1, 2, 341]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001]);
const BLOCKED_CODES = new Set([368]);

function classify(status: number, error: GraphError | undefined): ErrorKind {
  const code = error?.code ?? -1;
  if (code === 190) return "auth";
  if (BLOCKED_CODES.has(code)) return "blocked";
  if (RATE_LIMIT_CODES.has(code) || status === 429) return "rate_limited";
  if (error?.is_transient || TRANSIENT_CODES.has(code) || status >= 500) return "transient";
  return "permanent";
}

async function graph<T>(op: string, url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout("facebook", op, url, init, timeoutMs);
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

/**
 * Đăng Reels lên Page (developers.facebook.com/docs/video-api/guides/reels-publishing), 3 bước:
 * start → nhận video_id + upload_url; đẩy video lên rupload (luồng, có file_size); finish với video_state=PUBLISHED.
 * Facebook xử lý video bất đồng bộ sau bước finish. Trả về video_id.
 */
export async function publishReel(cfg: FacebookConfig, pageId: string, pageToken: string, reel: { caption: string; video: VideoStream }): Promise<string> {
  const url = `https://graph.facebook.com/${cfg.version}/${pageId}/video_reels`;
  const start = await graph<{ video_id: string; upload_url: string }>("reel_start", url, {
    method: "POST",
    body: new URLSearchParams({ upload_phase: "start", access_token: pageToken }),
  });
  // FixedLengthStream: gửi kèm Content-Length mà không đọc cả video vào bộ nhớ.
  const { readable, writable } = new FixedLengthStream(reel.video.size);
  // Lỗi giữa chừng (Drive ngắt) làm thiếu byte: fetch bên dưới tự báo lỗi, nên không cần chờ pipeTo.
  void reel.video.body.pipeTo(writable).catch(() => undefined);
  await graph("reel_upload", start.upload_url, {
    method: "POST",
    headers: { authorization: `OAuth ${pageToken}`, offset: "0", file_size: String(reel.video.size) },
    body: readable,
  }, VIDEO_TIMEOUT_MS);
  await graph("reel_finish", url, {
    method: "POST",
    body: new URLSearchParams({ upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: reel.caption, access_token: pageToken }),
  });
  return start.video_id;
}

// Chỉ số Page còn dùng được sau đợt Meta bỏ chỉ số (6/2026), đều là số đếm theo ngày nên cộng dồn được.
export const PAGE_METRICS = [
  "page_media_view",
  "page_post_engagements",
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_video_views",
  "page_views_total",
] as const;
export type PageMetric = (typeof PAGE_METRICS)[number];
export type DailySeries = Partial<Record<PageMetric, { date: string; value: number }[]>>;

const DAY_MS = 86_400_000;
const unix = (ms: number) => String(Math.floor(ms / 1000));

/** Số liệu theo ngày của Page (cần quyền read_insights). Facebook cho xem tối đa 90 ngày mỗi lần. */
export async function pageInsights(cfg: FacebookConfig, pageId: string, pageToken: string, since: number, until: number): Promise<DailySeries> {
  type Row = { name: PageMetric; period: string; values: { value: unknown; end_time: string }[] };
  const res = await graph<{ data: Row[] }>(
    "page_insights",
    graphUrl(cfg, `${pageId}/insights`, { metric: PAGE_METRICS.join(","), period: "day", since: unix(since), until: unix(until), access_token: pageToken }),
  );
  const out: DailySeries = {};
  // end_time là mốc cuối ngày được đếm, nên ngày của số liệu là end_time trừ 1 ngày.
  for (const m of res.data.filter((r) => r.period === "day")) {
    out[m.name] = m.values.map((v) => ({ date: new Date(Date.parse(v.end_time) - DAY_MS).toISOString().slice(0, 10), value: typeof v.value === "number" ? v.value : 0 }));
  }
  return out;
}

/** Tổng số người theo dõi Page hiện tại. */
export async function pageFollowers(cfg: FacebookConfig, pageId: string, pageToken: string): Promise<number | null> {
  const res = await graph<{ followers_count?: number; fan_count?: number }>("page_profile", graphUrl(cfg, pageId, { fields: "followers_count,fan_count", access_token: pageToken }));
  return res.followers_count ?? res.fan_count ?? null;
}

export type TopPost = {
  id: string;
  message: string;
  createdTime: string;
  permalink: string | null;
  picture: string | null;
  views: number;
  viewers: number;
  clicks: number;
  reactions: number;
  comments: number;
  shares: number;
};

/**
 * Bài Page đã đăng trong khoảng thời gian, kèm lượt xem/tương tác để xếp hạng nội dung hàng đầu.
 * shortcut: chỉ lấy 100 bài mới nhất trong khoảng, không đọc trang tiếp; tăng nếu Page đăng hơn 100 bài/khoảng.
 */
export async function topPosts(cfg: FacebookConfig, pageId: string, pageToken: string, since: number, until: number): Promise<TopPost[]> {
  type Raw = {
    id: string;
    message?: string;
    created_time: string;
    permalink_url?: string;
    full_picture?: string;
    shares?: { count: number };
    reactions?: { summary?: { total_count: number } };
    comments?: { summary?: { total_count: number } };
    insights?: { data: { name: string; values: { value: unknown }[] }[] };
  };
  const fields = [
    "id,message,created_time,permalink_url,full_picture,shares",
    "reactions.summary(total_count).limit(0)",
    "comments.summary(total_count).limit(0)",
    "insights.metric(post_media_view,post_total_media_view_unique,post_clicks)",
  ].join(",");
  const res = await graph<{ data: Raw[] }>(
    "top_posts",
    graphUrl(cfg, `${pageId}/published_posts`, { fields, since: unix(since), until: unix(until), limit: "100", access_token: pageToken }),
  );
  return res.data.map((p) => {
    const metric = (name: string) => {
      const v = p.insights?.data.find((m) => m.name === name)?.values[0]?.value;
      return typeof v === "number" ? v : 0;
    };
    return {
      id: p.id,
      message: p.message ?? "",
      createdTime: p.created_time,
      permalink: p.permalink_url ?? null,
      picture: p.full_picture ?? null,
      views: metric("post_media_view"),
      viewers: metric("post_total_media_view_unique"),
      clicks: metric("post_clicks"),
      reactions: p.reactions?.summary?.total_count ?? 0,
      comments: p.comments?.summary?.total_count ?? 0,
      shares: p.shares?.count ?? 0,
    };
  });
}
