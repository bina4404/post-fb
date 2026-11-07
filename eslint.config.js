import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".wrangler", "node_modules", "worker-configuration.d.ts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
);
