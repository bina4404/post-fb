// Secrets không có trong wrangler.jsonc nên `wrangler types` trên CI không sinh ra kiểu của chúng.
export type Secrets = {
  TOKEN_ENC_KEY: string;
  FB_APP_ID: string;
  FB_APP_SECRET: string;
  PINTEREST_APP_ID: string;
  PINTEREST_APP_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DEV_AUTH_BYPASS?: string;
};

export type WorkerEnv = Env & Secrets;

export type AppEnv = {
  Bindings: WorkerEnv;
  Variables: { email: string };
};
