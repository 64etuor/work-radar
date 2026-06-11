import type { HermesMessageRow } from "@/bindings";

import type { HermesMessage } from "./types";
import type { TabState } from "./useHermesTabs";
import { uid } from "./useHermesTabs";

const DEFAULT_SESSION_NAME = "새 세션";
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

/** 제네릭 이름 필터 — name 필드가 있는 배열에 적용 가능. */
export function filterByName<T extends { name: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

const PREVIEW_MAX = 48;

/** 마지막 user/assistant 메시지의 본문 미리보기. */
export function messagePreview(tab: Pick<TabState, "messages">): string {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m = tab.messages[i];
    if (m.role === "user") return clip(m.text);
    if (m.role === "assistant") return clip(m.chunks.join(""));
  }
  return "";
}

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

/** 상대 시각(한국어). now 주입 가능(테스트). */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 45) return "방금";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}
