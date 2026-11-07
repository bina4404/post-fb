import { app } from "./app";
import type { WorkerEnv } from "./env";
import { runCron } from "./jobs/cron";
import { handleQueue, type PublishMessage } from "./jobs/publish";

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<WorkerEnv, PublishMessage>;
