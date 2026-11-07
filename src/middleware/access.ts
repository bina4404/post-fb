import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppEnv } from "../env";

// Giữ JWKS giữa các request để không tải lại khoá mỗi lần (jose tự cache và tự làm mới).
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string) {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const env = c.env;
  if (env.DEV_AUTH_BYPASS === "1" && new URL(c.req.url).hostname === "localhost") {
    c.set("email", "dev@localhost");
    return next();
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  // Thiếu cấu hình thì từ chối tất cả, không bao giờ mở cửa.
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return c.json({ error: "forbidden" }, 403);
  }

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: env.ACCESS_AUD,
    });
    c.set("email", typeof payload.email === "string" ? payload.email : "");
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
});
