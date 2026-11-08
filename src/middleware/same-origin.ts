import { createMiddleware } from "hono/factory";

/**
 * Chống CSRF: trang web khác có thể khiến trình duyệt gửi POST kèm cookie Cloudflare Access của bạn.
 * Mọi request ghi (không phải GET/HEAD) phải đến từ chính trang này. Trình duyệt luôn gửi Sec-Fetch-Site / Origin;
 * công cụ không phải trình duyệt (curl, test) không gửi thì vẫn phải qua kiểm tra Access như thường.
 */
export const sameOriginWrites = createMiddleware(async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const site = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  const fromOtherSite = (site !== undefined && site !== "same-origin" && site !== "none") || (origin !== undefined && origin !== new URL(c.req.url).origin);
  if (fromOtherSite) return c.json({ error: "forbidden: cross-site request" }, 403);
  return next();
});
