import { type CSSProperties, useEffect, useMemo, useState } from "react";

import { detectLang, type ThemedToken, tokenizeLines } from "@/lib/shiki";

/** 표시 줄 상한 — 초과분은 비차단 위해 잘라 표시(전체는 외부 도구로). */
const MAX_DIFF_LINES = 6000;
/** 줄 묶음 단위 — content-visibility로 오프스크린 블록을 저렴하게 가상화. */
const BLOCK = 240;

/** 구문 강조를 적용할 코드 줄 수 상한 — 초과 시 평문(diff 색상만)으로 비차단 유지. */
const SYNTAX_MAX_LINES = 4000;

type ParsedDiffLine = {
  kind: "code" | "meta";
  cls: string;
  marker: string; // 코드 줄의 +/-/space, 메타 줄은 ""
  raw: string;
};

/** unified diff 한 줄을 분류하고 코드 줄은 마커(1글자) + 본문으로 분리. */
function parseDiffLine(raw: string): ParsedDiffLine {
  const cls = diffLineClass(raw);
  if (cls === "wt-l-add" || cls === "wt-l-del" || cls === "wt-l-ctx") {
    return { kind: "code", cls, marker: raw.slice(0, 1), raw };
  }
  return { kind: "meta", cls, marker: "", raw };
}

/** Shiki ThemedToken.fontStyle 비트마스크(1 italic / 2 bold / 4 underline) → React 스타일. */
function tokenStyle(t: ThemedToken): CSSProperties {
  const s: CSSProperties = { color: t.color };
  const fs = t.fontStyle ?? 0;
  if (fs & 1) s.fontStyle = "italic";
  if (fs & 2) s.fontWeight = 600;
  if (fs & 4) s.textDecoration = "underline";
  return s;
}

/**
 * unified diff 텍스트를 렌더. diff 줄 배경(추가/삭제/hunk/메타)은 유지하면서, 코드 줄은
 * 파일 확장자로 감지한 언어로 Shiki 구문강조(github-light)를 입힌다. 강조 준비 전이나
 * 미지원 언어/대용량(SYNTAX_MAX_LINES 초과)이면 평문으로 폴백한다.
 * 큰 diff는 줄을 블록으로 묶고 content-visibility:auto로 오프스크린을 가상화하며,
 * MAX_DIFF_LINES 초과 시 잘라 비차단을 보장한다.
 */
export function DiffText({ text, path }: { text: string; path: string | null }) {
  const allLines = useMemo(() => (text.length === 0 ? [] : text.split("\n")), [text]);
  const truncated = allLines.length > MAX_DIFF_LINES;

  const parsed = useMemo<ParsedDiffLine[]>(() => {
    const lines = allLines.length > MAX_DIFF_LINES ? allLines.slice(0, MAX_DIFF_LINES) : allLines;
    return lines.map(parseDiffLine);
  }, [allLines]);

  const lang = useMemo(() => detectLang(path), [path]);

  // 코드 줄만 모아 한 번에 토크나이즈(문맥 유지 + 단일 패스). 마커는 제외.
  const { codeText, codeIndices } = useMemo(() => {
    const indices: number[] = [];
    const texts: string[] = [];
    parsed.forEach((p, i) => {
      if (p.kind === "code") {
        indices.push(i);
        texts.push(p.raw.slice(1));
      }
    });
    return { codeText: texts.join("\n"), codeIndices: indices };
  }, [parsed]);

  // parsed 인덱스 → 토큰 줄. 강조 준비 전/미지원이면 null(평문 렌더).
  const [tokenState, setTokenState] = useState<{
    lang: string;
    codeText: string;
    map: Map<number, ThemedToken[]>;
  } | null>(null);
  const tokenByLine =
    tokenState?.lang === lang && tokenState.codeText === codeText ? tokenState.map : null;

  useEffect(() => {
    if (!lang || codeIndices.length === 0 || codeIndices.length > SYNTAX_MAX_LINES) {
      return;
    }
    let cancelled = false;
    void tokenizeLines(codeText, lang)
      .then((tokens) => {
        if (cancelled || tokens.length !== codeIndices.length) return;
        const map = new Map<number, ThemedToken[]>();
        codeIndices.forEach((pi, k) => map.set(pi, tokens[k]));
        setTokenState({ lang, codeText, map });
      })
      .catch(() => {
        /* 강조 실패 → 평문 폴백 */
      });
    return () => {
      cancelled = true;
    };
  }, [codeText, lang, codeIndices]);

  if (parsed.length === 0) {
    return <div className="wt-empty">변경 내용이 없습니다.</div>;
  }

  const blocks: ParsedDiffLine[][] = [];
  for (let i = 0; i < parsed.length; i += BLOCK) {
    blocks.push(parsed.slice(i, i + BLOCK));
  }

  return (
    <div className="wt-diff-text">
      {blocks.map((block, bi) => (
        <div key={bi} className="wt-diff-block">
          {block.map((p, li) => {
            const tokens = tokenByLine?.get(bi * BLOCK + li);
            if (p.kind === "code" && tokens) {
              return (
                <div key={li} className={`wt-line ${p.cls}`}>
                  <span className="wt-mark">{p.marker}</span>
                  {tokens.map((t, ti) => (
                    <span key={ti} style={tokenStyle(t)}>
                      {t.content}
                    </span>
                  ))}
                </div>
              );
            }
            return (
              <div key={li} className={`wt-line ${p.cls}`}>
                {p.raw || " "}
              </div>
            );
          })}
        </div>
      ))}
      {truncated && (
        <div className="wt-trunc">
          큰 diff — {MAX_DIFF_LINES.toLocaleString()}/{allLines.length.toLocaleString()}줄만 표시.
        </div>
      )}
    </div>
  );
}

/** 한 diff 줄 → CSS 클래스(추가/삭제/hunk/메타/컨텍스트). */
function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "wt-l-hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files")
  ) {
    return "wt-l-meta";
  }
  if (line.startsWith("+")) return "wt-l-add";
  if (line.startsWith("-")) return "wt-l-del";
  return "wt-l-ctx";
}
