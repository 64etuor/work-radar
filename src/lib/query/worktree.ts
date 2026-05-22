import {
  useQuery,
} from "@tanstack/react-query";
import { unwrap } from "./client";
import {
  commands,
  type DiffMode,
} from "@/bindings";

/** repo별 worktree 목록 (projectId=null이면 멀티 repo 전체). */
export function useWorktrees(projectId: string | null) {
  return useQuery({
    queryKey: ["worktrees", projectId],
    queryFn: () => unwrap(commands.listWorktrees(projectId)),
    staleTime: 10_000,
  });
}

/** worktree의 로컬+원격추적 브랜치 (branch↔branch picker용). 경로 있을 때만. */
export function useWorktreeBranches(worktreePath: string | null) {
  return useQuery({
    queryKey: ["worktreeBranches", worktreePath],
    queryFn: () => unwrap(commands.listWorktreeBranches(worktreePath as string)),
    enabled: !!worktreePath,
  });
}

/** 비교 모드의 변경 파일 목록(통계). ready=false면 비활성(ref 미선택 모드 대기). */
export function useWorktreeDiffFiles(args: {
  worktreePath: string | null;
  mode: DiffMode;
  baseRef: string | null;
  headRef: string | null;
  ready: boolean;
}) {
  const { worktreePath, mode, baseRef, headRef, ready } = args;
  return useQuery({
    queryKey: ["worktreeDiffFiles", worktreePath, mode, baseRef, headRef],
    queryFn: () =>
      unwrap(
        commands.worktreeDiffFiles(worktreePath as string, mode, baseRef, headRef),
      ),
    enabled: !!worktreePath && ready,
  });
}

/** 선택한 한 파일의 unified diff 텍스트 (지연 로드 — 파일 선택 시에만). */
export function useWorktreeFileDiff(args: {
  worktreePath: string | null;
  mode: DiffMode;
  baseRef: string | null;
  headRef: string | null;
  path: string | null;
  ready: boolean;
}) {
  const { worktreePath, mode, baseRef, headRef, path, ready } = args;
  return useQuery({
    queryKey: ["worktreeFileDiff", worktreePath, mode, baseRef, headRef, path],
    queryFn: () =>
      unwrap(
        commands.worktreeFileDiff(
          worktreePath as string,
          mode,
          baseRef,
          headRef,
          path as string,
        ),
      ),
    enabled: !!worktreePath && !!path && ready,
  });
}

// ── Agent 잡 큐 (Phase 7) ──────────────────────────────────────────────────────
//
// 잡은 agent_runs에 영속(INVARIANT #7). Jobs 뷰가 주기 폴링으로 상태 전이를 따라간다.
// codex 미설치/미인증이면 자동화 트리거 UI 비활성(graceful degrade).
