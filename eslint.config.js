// ESLint flat config — 표준 Vite React + TS 구성.
// 게이트는 보수적(에러만 차단). 생성물(src/bindings.ts)·Rust 트리(src-tauri)·
// 빌드 산출물(dist)·벤더링된 도구 디렉터리(.claude/.codex/...)는 린트 제외.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "src/bindings.ts",
      "src-tauri/**",
      // 앱 소스가 아닌 벤더링/도구 디렉터리 (스킬 템플릿 .tsx 등)
      ".claude/**",
      ".codex/**",
      ".gstack/**",
      ".omc/**",
      ".playwright-mcp/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // 린터를 기존 코드베이스(84파일/13k줄)에 도입하는 단계 — react-hooks v7가
      // 추가한 React Compiler 계열 룰은 이 코드가 의도적으로 쓰는 패턴(native
      // 리스너용 ref, effect 내 setState 등, docs/decisions.md 참조)을 다수 잡는다.
      // 일괄 수정은 고위험 광범위 리팩터라 지금은 warn으로 가시화만(점진 정리는 백로그).
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // exhaustive-deps는 전통적으로 warn (의도적 disable 주석이 이미 존재).
      "react-hooks/exhaustive-deps": "warn",
      // Fast Refresh 휴리스틱은 DX 경고지 정합성 에러가 아니다(표준 Vite 템플릿과 동일).
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  // 마지막에 와야 함 — Prettier와 충돌하는 stylistic 룰을 비활성화.
  prettier,
);
