import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    // Binding và secrets do vitest.config.ts cấp cho môi trường test.
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      TOKEN_ENC_KEY: string;
      FB_APP_ID: string;
      FB_APP_SECRET: string;
      PINTEREST_APP_ID: string;
      PINTEREST_APP_SECRET: string;
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
    }
  }
}
