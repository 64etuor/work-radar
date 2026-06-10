import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import pkg from "./package.json" with { type: "json" };

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // P6: react-query disk-persist buster를 앱 버전에 묶는다(버전 변경 시 디스크 캐시 자동 무효화).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`.
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // 4. + 에이전트 작업 영역 — .boule 워크트리 생성/제거가 레포 내부라 watch에
      //    잡히면 HMR 오반응 + chokidar fd/메모리 낭비 (governance/workspace = L0 이벤트 쓰기)
      ignored: ["**/src-tauri/**", "**/.boule/**", "**/governance/workspace/**"],
    },
  },
}));
