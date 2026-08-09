/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// ローカル開発でもCORSを発生させないため、Vite dev serverのプロキシに本番のCloudFront
// Function(prefix剥がし)と同じ役割を持たせる(docs/adr/0007)。フロントエンドのコードは
// 環境によらず `/query-api/...` `/command-api/...` という相対パスしか叩かない。
//
// 実際のAPI URL(`aws cloudformation describe-stacks --stack-name
// MonetaAccountPipelineStack --query "Stacks[0].Outputs"`の`QueryApiUrl`/`CommandApiUrl`)は
// `.env.local`(gitignore対象、`.env.local.example`参照)で指定する。
function apiProxy(target: string | undefined, prefix: string): Record<string, ProxyOptions> {
  if (!target) return {};
  const url = new URL(target);
  const stagePath = url.pathname.replace(/\/$/, "");
  return {
    [prefix]: {
      target: url.origin,
      changeOrigin: true,
      rewrite: (path) => path.replace(new RegExp(`^${prefix}`), stagePath),
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    server: {
      proxy: {
        ...apiProxy(env.VITE_QUERY_API_URL, "/query-api"),
        ...apiProxy(env.VITE_COMMAND_API_URL, "/command-api"),
        ...apiProxy(env.VITE_TRANSFER_QUERY_API_URL, "/transfer-query-api"),
        ...apiProxy(env.VITE_TRANSFER_COMMAND_API_URL, "/transfer-command-api"),
      },
    },
    test: {
      environment: "jsdom",
    },
  };
});
