import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

// 빌드용 vite.config.ts와 분리한 테스트 전용 설정(빌드 경로 무영향).
// 현재는 순수 함수만 대상이라 node 환경으로 충분하다(jsdom/RTL 미도입).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
