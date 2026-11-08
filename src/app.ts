import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./env";
import { log } from "./lib/log";
import { requireAccess } from "./middleware/access";
import { sameOriginWrites } from "./middleware/same-origin";
import { accountRoutes } from "./routes/accounts";
import { importRoutes } from "./routes/import";
import { mediaRoutes } from "./routes/media";
import { oauthRoutes } from "./routes/oauth";
import { postRoutes } from "./routes/posts";
import { scheduleRoutes } from "./routes/schedule";
import { slotRoutes } from "./routes/slots";
import { targetRoutes } from "./routes/targets";

export const app = new Hono<AppEnv>().basePath("/api");

app.use("*", sameOriginWrites);
app.use("*", requireAccess);

app.get("/me", (c) => c.json({ email: c.get("email") }));
app.route("/posts", postRoutes);
app.route("/posts", scheduleRoutes);
app.route("/media", mediaRoutes);
app.route("/import", importRoutes);
app.route("/slots", slotRoutes);
app.route("/accounts", accountRoutes);
app.route("/oauth", oauthRoutes);
app.route("/targets", targetRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  log("error", "unhandled_error", { path: c.req.path, message: err.message });
  return c.json({ error: "internal error" }, 500);
});
