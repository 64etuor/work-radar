import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { unwrap } from "./client";
import {
  commands,
  type CreateProjectInput,
  type CreateRepoInput,
  type SetProjectCalendarColorInput,
} from "@/bindings";

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

/** 레포 추가. */
export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepoInput) => unwrap(commands.createRepo(input)),
    onSuccess: (repo) =>
      qc.invalidateQueries({ queryKey: ["repos", repo.projectId] }),
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
