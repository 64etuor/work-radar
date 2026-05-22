import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { unwrap } from "./client";
import {
  commands,
  type CalendarEvent,
  type CreateCalendarEventInput,
  type CreatedCalendarEvent,
  type SelectedCalendar,
} from "@/bindings";

/** Today 콕핏용 캘린더 이벤트 쿼리 래퍼(ambient — 짧은 staleTime). projectId=null → 전 프로젝트 병합. */
export function useCalendarEvents(date: string) {
  return useQuery<CalendarEvent[]>({
    queryKey: ["calendarEvents", date],
    queryFn: () => fetchCalendarEvents(null, date),
    staleTime: 60_000,
    retry: 1,
  });
}

/** 프로젝트별 Google Calendar 연결 상태(hasClient/connected). 토큰 본문 미노출. */
export function useGoogleCalendarStatus(projectId: string) {
  return useQuery({
    queryKey: ["googleCalendarStatus", projectId],
    queryFn: () => unwrap(commands.googleCalendarStatus(projectId)),
    enabled: !!projectId,
  });
}

/** OAuth client(client_id/secret) 저장. 본문은 IPC 인자로만 전달, 캐시 미저장. */
export function useSetGoogleOauthClient() {
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
    }) =>
      unwrap(commands.setGoogleOauthClient(projectId, clientId, clientSecret)),
    onSuccess: (_data, v) =>
      qc.invalidateQueries({ queryKey: ["googleCalendarStatus", v.projectId] }),
  });
}

/** loopback + PKCE OAuth 실행(브라우저 동의 → refresh_token keychain 저장). bounded timeout. */
export function useStartGoogleOauth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      unwrap(commands.startGoogleOauth(projectId)),
    onSuccess: (_data, projectId) =>
      qc.invalidateQueries({ queryKey: ["googleCalendarStatus", projectId] }),
  });
}

/** 연결 해제(keychain blob 삭제). */
export function useDisconnectGoogle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      unwrap(commands.disconnectGoogle(projectId)),
    onSuccess: (_data, projectId) =>
      qc.invalidateQueries({ queryKey: ["googleCalendarStatus", projectId] }),
  });
}

/** 연결 검증(read-only refresh). 결과(PingResult)를 호출부가 표시. */
export function usePingGoogleCalendar() {
  return useMutation({
    mutationFn: (projectId: string) =>
      unwrap(commands.pingGoogleCalendar(projectId)),
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
    mutationFn: ({
      projectId,
      calendars,
    }: {
      projectId: string;
      calendars: SelectedCalendar[];
    }) => unwrap(commands.setSelectedCalendars(projectId, calendars)),
    onSuccess: (_data, v) => {
      void qc.invalidateQueries({ queryKey: ["googleCalendars", v.projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/**
 * 오늘 캘린더 이벤트 fetch 헬퍼 (Phase 11 Today/Timeline이 소비). projectId=null이면 전체 병합.
 * ambient read — 캐시하지 않고 호출부가 필요 시 직접 부른다(영속 없음).
 */
export function fetchCalendarEvents(
  projectId: string | null,
  date: string,
): Promise<CalendarEvent[]> {
  return unwrap(commands.fetchCalendarEvents(projectId, date));
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
  return useMutation<
    CreatedCalendarEvent,
    Error,
    { projectId: string; calendarId: string; event: CreateCalendarEventInput }
  >({
    mutationFn: ({ projectId, calendarId, event }) =>
      unwrap(commands.createCalendarEvent(projectId, calendarId, event)),
  });
}

// ── Phase 4: PR Radar (read 레일) ───────────────────────────────────────────────
