import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type CalendarEvent,
  commands,
  type CreateCalendarEventInput,
  type CreatedCalendarEvent,
  type SelectedCalendar,
  type WorkSignal,
} from "@/bindings";

import { unwrap } from "./client";

/** Today 콕핏용 캘린더 이벤트 쿼리 래퍼(ambient — 짧은 staleTime). projectId=null → 전 프로젝트 병합. */
export function useCalendarEvents(date: string) {
  return useQuery<CalendarEvent[]>({
    queryKey: ["calendarEvents", date],
    // 폴링/재마운트는 캐시 가속(force=false). 수동 새로고침(P7 드로어)은 force=true로 별도 호출.
    queryFn: () => fetchCalendarEvents(null, date, false),
    staleTime: 60_000,
    retry: 1,
  });
}

/** 프로젝트별 Google 계정 연결 상태(hasClient/connected). 토큰 본문 미노출. */
export function useGoogleAccountStatus(projectId: string) {
  return useQuery({
    queryKey: ["googleAccountStatus", projectId],
    queryFn: () => unwrap(commands.googleCalendarStatus(projectId)),
    enabled: !!projectId,
  });
}

/** OAuth client(client_id/secret) 저장. 본문은 IPC 인자로만 전달, 캐시 미저장. */
export function useSetGoogleAccountOauthClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      clientId,
      clientSecret,
    }: {
      projectId: string;
      clientId: string;
      clientSecret: string;
    }) => unwrap(commands.setGoogleOauthClient(projectId, clientId, clientSecret)),
    onSuccess: (_data, v) =>
      qc.invalidateQueries({ queryKey: ["googleAccountStatus", v.projectId] }),
  });
}

/** loopback + PKCE OAuth 실행(브라우저 동의 → refresh_token keychain 저장). bounded timeout. */
export function useStartGoogleAccountOauth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.startGoogleOauth(projectId)),
    onSuccess: (_data, projectId) =>
      qc.invalidateQueries({ queryKey: ["googleAccountStatus", projectId] }),
  });
}

/** 진행 중인 loopback OAuth 대기를 취소한다. */
export function useCancelGoogleAccountOauth() {
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.cancelGoogleOauth(projectId)),
  });
}

/** 연결 해제(keychain blob 삭제). */
export function useDisconnectGoogleAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.disconnectGoogle(projectId)),
    onSuccess: (_data, projectId) =>
      qc.invalidateQueries({ queryKey: ["googleAccountStatus", projectId] }),
  });
}

/** 연결 검증(read-only refresh). 결과(PingResult)를 호출부가 표시. */
export function usePingGoogleAccount() {
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.pingGoogleCalendar(projectId)),
  });
}

// ── Phase 10b: 캘린더 선택 + 이벤트 ────────────────────────────────────────────────

/** calendarList(다중 선택 picker용). 연결됨일 때만 조회(enabled). */
export function useGoogleCalendars(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["googleCalendars", projectId],
    queryFn: () => unwrap(commands.listGoogleCalendars(projectId)),
    enabled: !!projectId && enabled,
    staleTime: 60_000,
  });
}

/** 선택 캘린더 목록 저장([{id,summary}]). */
export function useSetSelectedCalendars() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, calendars }: { projectId: string; calendars: SelectedCalendar[] }) =>
      unwrap(commands.setSelectedCalendars(projectId, calendars)),
    onSuccess: (_data, v) => {
      void qc.invalidateQueries({ queryKey: ["googleCalendars", v.projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/**
 * 오늘 캘린더 이벤트 fetch 헬퍼 (Phase 11 Today/Timeline이 소비). projectId=null이면 전체 병합.
 * ambient read — 캐시하지 않고 호출부가 필요 시 직접 부른다(영속 없음).
 * `forceRefresh=true`면 Rust TTL 캐시를 우회해 fresh Google fetch(P7 드로어 수동 새로고침 버튼용).
 */
function fetchCalendarEvents(
  projectId: string | null,
  date: string,
  forceRefresh = false,
): Promise<CalendarEvent[]> {
  return unwrap(commands.fetchCalendarEvents(projectId, date, forceRefresh));
}

/**
 * P7 캘린더 드로어용 임의 [start,end] 범위 이벤트 쿼리(ambient — 일/주/월 뷰). 경계 산출(주 시작 요일·
 * 월 경계)은 프런트(calendarRange)가 정하고, Rust는 단일 윈도우로 감싸 **캘린더당 단일 range 호출**한다
 * (주/월도 N일×1콜 아님). 캐시 키에 [start,end] 포함 → 일/주/월 각 범위가 독립 캐시(P6 persist allowlist
 * `calendarEvents` 적용). 폴링/재방문은 force=false(캐시 가속), 수동 새로고침은 force=true(별도 호출).
 */
export function useCalendarEventsRange(start: string, end: string, enabled = true) {
  return useQuery<CalendarEvent[]>({
    queryKey: ["calendarEvents", "range", start, end],
    queryFn: () => fetchCalendarEventsRange(null, start, end, false),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * 범위 캘린더 이벤트 fetch 헬퍼. projectId=null이면 전체 병합. `forceRefresh=true`면 Rust TTL 캐시를
 * 우회해 fresh Google fetch(드로어 수동 새로고침 버튼용 — 표시 가속 전용, 결정 레일 무관).
 */
export function fetchCalendarEventsRange(
  projectId: string | null,
  start: string,
  end: string,
  forceRefresh = false,
): Promise<CalendarEvent[]> {
  return unwrap(commands.fetchCalendarEventsRange(projectId, start, end, forceRefresh));
}

// ── Phase 19: 이벤트 생성 (write 레일, 직접 모달) ────────────────────────────────────
//
// INVARIANT #2: 사용자 폼 제출 = 사람 결정 → 직접 write 정합(Acceptance 게이트는 자동화용).
// 토큰은 keychain(Rust) — 본문 미노출. 실패는 graceful로 호출부가 표시.

/** 직접 모달 picker용 — 프로젝트의 저장된 선택 캘린더(로컬 DB, 네트워크 없음). 연결됨일 때만 조회. */
export function useSelectedCalendars(projectId: string | null, enabled: boolean) {
  return useQuery<SelectedCalendar[]>({
    queryKey: ["selectedCalendars", projectId],
    queryFn: () => unwrap(commands.listSelectedCalendars(projectId as string)),
    enabled: !!projectId && enabled,
    staleTime: 60_000,
  });
}

/** 카드 → 캘린더 이벤트 생성(write). 사람 폼 제출이 곧 결정/accept(Acceptance 대기 없음, #2). */
export function useCreateCalendarEvent() {
  const qc = useQueryClient();
  return useMutation<
    CreatedCalendarEvent,
    Error,
    { projectId: string; calendarId: string; event: CreateCalendarEventInput }
  >({
    mutationFn: ({ projectId, calendarId, event }) =>
      unwrap(commands.createCalendarEvent(projectId, calendarId, event)),
    // 생성 즉시 Today/드로어의 calendarEvents(단일 date + range) 양쪽 갱신.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendarEvents"] }),
  });
}

// ── Phase 8 #3: 캘린더 긴급도 가중 (표시 힌트 전용 — suggested_quadrant만) ─────────────
//
// 카드 title/keywords를 (이미 표시 중인 ambient) 캘린더 이벤트 title과 퍼지 매칭해, 연관 이벤트가
// 임박하면 그 카드의 suggested_quadrant 힌트만 위로 가중한다. 확정 quadrant(사람 결정 위치)는 절대
// 안 건드린다(INVARIANT #1 — 카드 자동 이동 0). 점수는 Rust 순수 함수(urgency.rs, cargo test).

/** 미분류 카드 1개에 캘린더 긴급도 가중 적용(suggested_quadrant 힌트만). 성공 시 signals invalidate. */
export function useApplyCalendarUrgency() {
  const qc = useQueryClient();
  return useMutation<
    WorkSignal,
    Error,
    { signalId: string; keywords: string[]; events: CalendarEvent[] }
  >({
    mutationFn: ({ signalId, keywords, events }) =>
      unwrap(commands.applyCalendarUrgency(signalId, keywords, events)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["signals"] }); // suggested 힌트 칩 반영.
    },
  });
}

// ── Phase 4: PR Radar (read 레일) ───────────────────────────────────────────────
