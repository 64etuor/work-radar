// react-query disk-persist 설정 (P6 — 캐싱 레이어, 프런트).
//
// 부팅 시 localStorage에서 ambient *표시* 데이터를 복원해 첫 페인트를 가속한다.
// **결정 큐는 절대 persist하지 않는다(INVARIANT).** 매트릭스/시그널(결정 레일 #1),
// triage/enrich/PR 제안(Acceptance 게이트 #2), 에이전트 런(실행 레일)은 재시작 시 항상
// fresh 로드 — 사람의 결정/승인이 stale 디스크 사본으로 이뤄지면 안 된다.
//
// 정책: **allowlist(deny-by-default).** 아래 ambient 표시 키만 persist하고, 그 외(결정 큐
// 포함)는 모두 디스크에 쓰지 않는다. 새 쿼리 키는 명시적으로 추가해야 persist된다(안전 기본값).

import { defaultShouldDehydrateQuery, type Query } from "@tanstack/react-query";

/**
 * persist 대상(ambient 표시 데이터)의 query key prefix allowlist.
 * **결정 큐(`signals`)·제안 큐(`*Proposal`, `agentRuns`/`agentLog`)는 의도적으로 제외** —
 * 재시작 시 fresh 로드(사람 결정/Acceptance가 stale 사본을 보지 않도록).
 */
export const PERSIST_ALLOWED_KEY_PREFIXES: readonly string[] = [
  // 외부 ambient 읽기 (표시 가속의 핵심).
  "prRadar", // PR Radar 버킷(표시) — escalate 판정은 Rust가 fresh로 수행, 이건 표시 사본.
  "prRadarSettings", // 설정 표시값. 실제 SSOT는 SQLite app_config.
  "calendarEvents", // Google Calendar 이벤트(오늘/Today 표시).
  "googleCalendars", // calendarList(picker 표시).
  "selectedCalendars", // 선택 캘린더(로컬 DB 표시).
  // 로컬 파생 표시 집계(결정 데이터 아님 — 보기 전용).
  "todayOverview",
  "today",
  "completed",
  "weeklyReview",
  "archivedSnoozed",
  "routines",
  "routine-tracking",
  // 로컬 read-only 표시(워크트리/레포/프로젝트 메타).
  "worktrees",
  "worktreeBranches",
  "repos",
  "projects",
  // 연결/도구 상태 표시(토큰 본문 미포함 — 상태 플래그만).
  "tokenStatus",
  "googleAccountStatus",
  "ghCliStatus",
  "ntnCliStatus",
  "codexStatus",
  "codexModel",
  "cmuxStatus",
  "navKeymap",
  "globalHotkey",
  "notificationPermission",
  "skills",
  "externalSkills",
];

/**
 * 디스크 persist 제외(denylist) — 문서/테스트용 명시 목록. 결정/제안/실행 레일 데이터.
 * 실제 게이트는 allowlist지만, 이 목록이 prefix에 들어오면 안 됨을 테스트로 잠근다.
 */
export const PERSIST_DENIED_KEY_PREFIXES: readonly string[] = [
  "signals", // Eisenhower 매트릭스(결정 레일 #1) — 사람만 결정. 항상 fresh.
  "triageProposal", // CI triage 제안(Acceptance #2).
  "enrichProposal", // enrich 제안(Acceptance #2).
  "batchEnrichProposal",
  "prProposal", // PR draft 제안(Acceptance #2).
  "agentRuns", // 에이전트 런 큐(실행 레일).
  "agentLog",
];

/** query key의 첫 세그먼트(string prefix). 비표준 키는 빈 문자열. */
function keyPrefix(query: Query): string {
  const head = query.queryKey?.[0];
  return typeof head === "string" ? head : "";
}

/**
 * 이 query를 디스크에 dehydrate(persist)할지. allowlist에 든 ambient 표시 키 + RQ 기본 조건
 * (성공한 query만)을 모두 만족해야 한다. 결정 큐는 allowlist에 없으므로 자동 제외.
 * 순수 함수 — 단위테스트 가능(외부 상태 없음).
 */
export function shouldPersistQuery(query: Query): boolean {
  if (!PERSIST_ALLOWED_KEY_PREFIXES.includes(keyPrefix(query))) return false;
  // promise/에러 미완료는 persist 금지(RQ 기본 — 성공한 query만 직렬화).
  return defaultShouldDehydrateQuery(query);
}

// vite.config.ts의 define으로 package.json version이 빌드 타임에 주입된다.
declare const __APP_VERSION__: string;

/** persist 캐시 무효화 버스터(앱 버전). 스키마/버전이 바뀌면 기존 디스크 캐시는 자동 폐기. */
export const PERSIST_BUSTER: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** 디스크 캐시 최대 보관(만료). 24h 지난 사본은 복원 시 silently 폐기된다. */
export const PERSIST_MAX_AGE_MS = 1000 * 60 * 60 * 24;
