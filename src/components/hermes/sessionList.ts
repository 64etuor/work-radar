import type { HermesMessageRow, HermesSessionRow } from "@/bindings";

import type { HermesMessage } from "./types";
import { uid } from "./useHermesTabs";

export const DEFAULT_SESSION_NAME = "새 세션";
const TITLE_MAX = 40;

/** 첫 user 메시지로 세션 제목 생성. 비면 기본 이름. */
export function autoTitleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return DEFAULT_SESSION_NAME;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** 세션 이름이 비었거나 기본값이면 자동 제목 대상. */
export function shouldAutoTitle(name: string): boolean {
  return !name.trim() || name === DEFAULT_SESSION_NAME;
}

/** DB 메시지 행 → reducer가 렌더하는 HermesMessage[]. assistant는 done=true(과거 turn). */
export function rowsToMessages(rows: HermesMessageRow[]): HermesMessage[] {
  return rows.map((r) => {
    if (r.role === "assistant") {
      const tools = r.toolJson ? safeParseTools(r.toolJson) : [];
      return {
        id: uid(),
        role: "assistant" as const,
        chunks: r.content ? [r.content] : [],
        toolCalls: tools,
        ts: Date.parse(r.createdAt) || Date.now(),
        done: true,
      };
    }
    if (r.role === "system") {
      return {
        id: uid(),
        role: "system" as const,
        text: r.content,
        level: "info" as const,
        ts: Date.parse(r.createdAt) || Date.now(),
      };
    }
    return {
      id: uid(),
      role: "user" as const,
      text: r.content,
      images: [],
      ts: Date.parse(r.createdAt) || Date.now(),
    };
  });
}

function safeParseTools(json: string) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 검색 필터 — 이름 부분일치(대소문자 무시). */
export function filterSessions(rows: HermesSessionRow[], query: string): HermesSessionRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}
