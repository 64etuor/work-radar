import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands, type TokenKind } from "@/bindings";

/** 토큰 존재 여부만(본문 미노출 — INVARIANT). 마스킹 표시용. */
export function useProjectTokenStatus(projectId: string) {
  return useQuery({
    queryKey: ["tokenStatus", projectId],
    queryFn: () => unwrap(commands.projectTokenStatus(projectId)),
    enabled: !!projectId,
  });
}

/**
 * 토큰 저장. 토큰은 IPC 인자로만 전달되고 캐시에 저장하지 않는다(INVARIANT: 렌더러 미노출).
 * 성공 후 token status만 무효화한다(본문 아님).
 */
export function useSetProjectToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      kind,
      token,
    }: {
      projectId: string;
      kind: TokenKind;
      token: string;
    }) => unwrap(commands.setProjectToken(projectId, kind, token)),
    onSuccess: (_data, v) => qc.invalidateQueries({ queryKey: ["tokenStatus", v.projectId] }),
  });
}

/** 토큰 삭제(클리어). */
export function useDeleteProjectToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, kind }: { projectId: string; kind: TokenKind }) =>
      unwrap(commands.deleteProjectToken(projectId, kind)),
    onSuccess: (_data, v) => qc.invalidateQueries({ queryKey: ["tokenStatus", v.projectId] }),
  });
}

/** 토큰으로 외부 API ping(read-only). 결과(PingResult)를 호출부가 표시. */
export function usePingProjectToken() {
  return useMutation({
    mutationFn: ({ projectId, kind }: { projectId: string; kind: TokenKind }) =>
      unwrap(commands.pingProjectToken(projectId, kind)),
  });
}

// ── CLI 토큰 import (auth 통일, Phase 14) ──────────────────────────────────────
//
// INVARIANT: 토큰 본문은 Rust 안에서 keychain으로만 간다 — 이 훅들은 토큰을 인자/반환으로
// 다루지 않는다(상태/결과는 boolean·detail만). gh/ntn 가져오기 = 1차 어포던스, paste = fallback.

/** gh CLI 설치/로그인 상태(graceful degrade 판정). 토큰 본문 미포함. */
export function useGhCliStatus() {
  return useQuery({
    queryKey: ["ghCliStatus"],
    queryFn: () => unwrap(commands.ghCliStatus()),
  });
}

/** ntn CLI 설치/로그인(토큰 import 가능) 상태. 토큰 본문 미포함. */
export function useNtnCliStatus() {
  return useQuery({
    queryKey: ["ntnCliStatus"],
    queryFn: () => unwrap(commands.ntnCliStatus()),
  });
}

/** `gh auth token` → keychain(GitHub). 토큰은 Rust→keychain으로만, 렌더러 미노출. */
export function useImportGithubToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.importGithubToken(projectId)),
    onSuccess: (_data, projectId) => qc.invalidateQueries({ queryKey: ["tokenStatus", projectId] }),
  });
}

/** ntn file-auth 토큰 → keychain(Notion). 토큰은 Rust→keychain으로만, 렌더러 미노출. */
export function useImportNotionToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.importNotionToken(projectId)),
    onSuccess: (_data, projectId) => qc.invalidateQueries({ queryKey: ["tokenStatus", projectId] }),
  });
}

/** `gh auth login --web` 런처(미로그인 시). 완료 후 사용자가 '가져오기'를 다시 누른다. */
export function useGhAuthLoginWeb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.ghAuthLoginWeb()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ghCliStatus"] }),
  });
}

/** `ntn login` 런처(미로그인 시). 완료 후 사용자가 '가져오기'를 다시 누른다. */
export function useNtnLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.ntnLogin()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ntnCliStatus"] }),
  });
}
