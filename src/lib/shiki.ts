import type { BundledLanguage, ThemedToken } from "shiki";

/**
 * Worktree diff 구문 강조용 Shiki 래퍼 (Phase 5 UI).
 * - 파일 확장자로 언어를 감지(파일 경로가 있으니 auto-detect보다 정확·무료).
 * - github-light 테마 = DESIGN.md white editorial과 톤 일치.
 * - shiki 코어는 첫 diff 강조 시점에 동적 import(앱 시작 번들에서 제외).
 *   codeToTokens 단축 함수는 싱글톤 하이라이터에 언어/테마를 지연 로드·캐시한다.
 */

/** 구문 강조에 쓰는 테마(밝은 에디토리얼). */
export const DIFF_THEME = "github-light";

/** 파일 확장자 → Shiki 번들 언어 id. 미지원 확장자는 강조 없이 평문 렌더. */
const EXT_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
  proto: "proto",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  clj: "clojure",
  r: "r",
};

/** 확장자 없이 이름만으로 알 수 있는 파일들. */
const NAME_LANG: Record<string, BundledLanguage> = {
  dockerfile: "docker",
  makefile: "make",
  ".gitignore": "ini",
  ".env": "dotenv",
};

/** 파일 경로 → Shiki 언어 id(없으면 null = 강조 안 함). */
export function detectLang(path: string | null): BundledLanguage | null {
  if (!path) return null;
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name in NAME_LANG) return NAME_LANG[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // 확장자 없음 또는 dotfile
  const ext = name.slice(dot + 1);
  return EXT_LANG[ext] ?? null;
}

/**
 * 코드 문자열을 줄 단위 토큰 배열로 토크나이즈.
 * 반환: 입력 줄마다 ThemedToken[] 한 개씩(= tokens[i] 가 i번째 줄).
 */
export async function tokenizeLines(
  code: string,
  lang: BundledLanguage,
): Promise<ThemedToken[][]> {
  const { codeToTokens } = await import("shiki");
  const { tokens } = await codeToTokens(code, { lang, theme: DIFF_THEME });
  return tokens;
}

export type { ThemedToken };
