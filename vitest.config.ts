import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            // Giá trị giả chỉ dùng cho test.
            TOKEN_ENC_KEY: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i))),
            FB_APP_ID: "fb-app",
            FB_APP_SECRET: "fb-secret",
            GOOGLE_CLIENT_ID: "g-client",
            GOOGLE_CLIENT_SECRET: "g-secret",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
