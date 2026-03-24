import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const apiProxyTarget = process.env.NEOSHELL_API_PROXY_TARGET ?? "http://127.0.0.1:4000";

  return {
    envDir: "../..",
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@neoshell/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
      }
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.removeHeader("origin");
            });
          }
        }
      }
    },
    preview: {
      host: "0.0.0.0",
      port: 3000,
      strictPort: true
    },
    test: {
      environment: "happy-dom",
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["./test/setup.ts"]
    }
  };
});
