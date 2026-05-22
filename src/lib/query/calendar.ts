import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { unwrap } from "./client";
import {
  commands,
  type CalendarEvent,
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

// ── Phase 4: PR Radar (read 레일) ───────────────────────────────────────────────
