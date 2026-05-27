import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type DiffMode } from "@/bindings";

import { unwrap } from "./client";

/**
 * worktree 목록 라이브 폴링 주기 (Phase 12c). bounded interval(busy-loop 아님 — INVARIANT #5).
 * dirty/ahead/behind + 활성 변경 활동(최근 파일 mtime)을 8s마다 갱신해 "지금 작업 중"을 비춘다.
 */
export const WORKTREE_POLL_MS = 8_000;

/**
 * repo별 worktree 목록 (projectId=null이면 멀티 repo 전체).
 * live=true면 WORKTREE_POLL_MS 주기로 자동 갱신(WorktreeView가 화면에 떠 있는 동안).
 */
export function useWorktrees(projectId: string | null, live = false) {
  return useQuery({
    queryKey: ["worktrees", projectId],
    queryFn: () => unwrap(commands.listWorktrees(projectId)),
    staleTime: 10_000,
    refetchInterval: live ? WORKTREE_POLL_MS : false,
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
      unwrap(commands.worktreeDiffFiles(worktreePath as string, mode, baseRef, headRef)),
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
        commands.worktreeFileDiff(worktreePath as string, mode, baseRef, headRef, path as string),
      ),
    enabled: !!worktreePath && !!path && ready,
  });
}

/** base...HEAD 커밋 그래프(drawer). read-only log, drawer가 열릴 때만 로드. */
export function useWorktreeCommitGraph(args: {
  worktreePath: string | null;
  baseRef: string | null;
  open: boolean;
}) {
  const { worktreePath, baseRef, open } = args;
  return useQuery({
    queryKey: ["worktreeCommitGraph", worktreePath, baseRef],
    queryFn: () => unwrap(commands.worktreeCommitGraph(worktreePath as string, baseRef as string)),
    enabled: open && !!worktreePath && !!baseRef,
  });
}

// ── Phase 12c: 안전 dev rebase ─────────────────────────────────────────────────────

/**
 * worktree를 base(기본 origin/dev) 위로 안전 rebase. dirty면 백엔드가 거부, 충돌이면 자동 복구.
 * 성공/실패 둘 다 RebaseResult로 돌아온다(throw는 dirty 거부 등 terminal failure만).
 * 성공 후 worktree 목록을 무효화해 ahead/behind 배지를 갱신한다.
 */
export function useRebaseWorktree() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { worktreePath: string; base: string | null }) =>
      unwrap(commands.rebaseWorktreeOnto(args.worktreePath, args.base)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worktrees"] }),
  });
}

// ── Phase 12d: 브랜치/워크트리 정리 ────────────────────────────────────────────────

/** 정리 후보(merged/stale 브랜치 + prunable worktree). repoPath 있을 때만. */
export function useCleanupCandidates(repoPath: string | null, base: string | null) {
  return useQuery({
    queryKey: ["cleanupCandidates", repoPath, base],
    queryFn: () => unwrap(commands.listCleanupCandidates(repoPath as string, base)),
    enabled: !!repoPath,
  });
}

/** 선택 정리 후보 삭제(보호/force 가드는 백엔드가 재확인). 성공 시 후보+worktree 목록 무효화. */
export function useDeleteCleanupCandidates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { repoPath: string; base: string | null; ids: string[]; force: boolean }) =>
      unwrap(commands.deleteCleanupCandidates(args.repoPath, args.base, args.ids, args.force)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cleanupCandidates"] });
      void qc.invalidateQueries({ queryKey: ["worktrees"] });
    },
  });
}

// ── Agent 잡 큐 (Phase 7) ──────────────────────────────────────────────────────
//
// 잡은 agent_runs에 영속(INVARIANT #7). Jobs 뷰가 주기 폴링으로 상태 전이를 따라간다.
// codex 미설치/미인증이면 자동화 트리거 UI 비활성(graceful degrade).
