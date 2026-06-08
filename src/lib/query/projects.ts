import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateProjectInput,
  type CreateRepoInput,
  type ProjectKind,
  type SetProjectCalendarColorInput,
  type SetProjectDefaultWriteCalendarInput,
  type SetProjectNotionDbIdsInput,
} from "@/bindings";

import { unwrap } from "./client";

/** 프로젝트 목록 (Phase 0). */
export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => unwrap(commands.listProjects()),
  });
}

/** project별 레포 목록. */
export function useRepos(projectId: string) {
  return useQuery({
    queryKey: ["repos", projectId],
    queryFn: () => unwrap(commands.listRepos(projectId)),
    enabled: !!projectId,
  });
}

/** 프로젝트 생성 (개인/업무). */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => unwrap(commands.createProject(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/** 프로젝트 삭제. 로컬 기록은 보존되고 project 연결만 해제된다(FK SET NULL). */
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.deleteProject(projectId)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["routines"] });
      void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
    },
  });
}

/**
 * 기존 프로젝트 이름 편집. 단일 컬럼 갱신이라 kind 토글과 독립 — 두 편집이 겹쳐도 서로
 * 덮어쓰지 않는다(lost-update 방지). 생성 후 사용자 편집 경로.
 */
export function useSetProjectName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      unwrap(commands.setProjectName(projectId, name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/**
 * 기존 프로젝트 종류(개인↔업무) 편집. 단일 컬럼 갱신이라 이름 편집과 독립.
 * kind 전환은 라우팅 카테고리만 이동 — 기존 신호는 자신의 kind를 보유하므로 재태깅하지 않는다.
 * CaptureBoard의 kind→프로젝트 라우팅은 projects 쿼리에서 라이브 산출되므로 ["projects"] 무효화로 충분.
 */
export function useSetProjectKind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, kind }: { projectId: string; kind: ProjectKind }) =>
      unwrap(commands.setProjectKind(projectId, kind)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/** 프로젝트별 캘린더 표시 배경색 저장. 글자색은 배경색 대비로 자동 산출된다. */
export function useSetProjectCalendarColor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetProjectCalendarColorInput) =>
      unwrap(commands.setProjectCalendarColor(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
    },
  });
}

/**
 * 프로젝트별 "일정 생성 기본 캘린더" 저장 (스펙 §6.5).
 * Today×Timeline DnD에서 trayrow를 캔버스에 떨어뜨릴 때, 해당 signal의 project default가
 * 없으면 popover로 묻고 "기본으로 저장" 체크 시 이 mutation으로 영속(다음부터 묻지 않음).
 */
export function useSetProjectDefaultWriteCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetProjectDefaultWriteCalendarInput) =>
      unwrap(commands.setProjectDefaultWriteCalendar(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/**
 * 프로젝트 Notion DB 바인딩(백로그/안건) 편집·해제. 생성 후 오타 수정/변경/연결 해제 경로.
 * 빈 값은 백엔드에서 해제(NULL)로 처리되고, 새 값은 토큰이 있으면 저장 전 라이브 검증된다.
 */
export function useSetProjectNotionDbIds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetProjectNotionDbIdsInput) =>
      unwrap(commands.setProjectNotionDbIds(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/** 레포 추가. */
export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepoInput) => unwrap(commands.createRepo(input)),
    onSuccess: (repo) => qc.invalidateQueries({ queryKey: ["repos", repo.projectId] }),
  });
}

/** 레포 연결 해제(제거). projectId는 무효화 대상 쿼리 키 산출용(서버 인자는 repoId만). */
export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId }: { repoId: string; projectId: string }) =>
      unwrap(commands.deleteRepo(repoId)),
    onSuccess: (_data, { projectId }) => qc.invalidateQueries({ queryKey: ["repos", projectId] }),
  });
}

/** 미태깅 신호를 kind→매칭 프로젝트로 reconcile. 태깅된 건수 반환. */
export function useReconcileSignalProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.reconcileSignalProjects()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
}

// ── Phase 10a: Google Calendar OAuth 연결 ──────────────────────────────────────────
//
// INVARIANT: client_id/secret/refresh_token은 keychain에만 — 캐시/렌더러에 본문을 두지 않는다.
// 상태는 boolean(hasClient/connected)만. read-only 스코프라 Acceptance 불요(PR Radar 선례).
