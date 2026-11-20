import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const d1 = "DB";
const r2 = "BUCKET";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const frontendOrigin = process.env.CHATHUB_FRONTEND_ORIGIN;
const standaloneConfig = frontendOrigin ? {
  name: process.env.CHATHUB_WORKER_NAME ?? "chathub-pages-api",
  compatibility_date: "2026-05-15",
  vars: { CHATHUB_FRONTEND_ORIGIN: frontendOrigin },
  routes: process.env.CHATHUB_API_HOST
    ? [{ pattern: process.env.CHATHUB_API_HOST, custom_domain: true as const }]
    : [],
  workers_dev: !process.env.CHATHUB_API_HOST,
} : {};

const localBindingConfig = {
  ...standaloneConfig,
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: process.env.CHATHUB_D1_NAME ?? "site-creator-d1",
          database_id: process.env.CHATHUB_D1_ID ?? SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          ...(frontendOrigin ? { migrations_dir: "../../drizzle" } : {}),
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: process.env.CHATHUB_R2_BUCKET ?? "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
