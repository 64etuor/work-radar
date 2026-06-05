import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands } from "@/bindings";

import { unwrap } from "./client";

// Phase 5: Gmail send(WRITE) 연결 설정. calendar.ts의 Google 계정 connect 훅을 미러링하되
// send-only라 ping/calendars 없음(검증=백엔드 refresh-ping). 토큰 본문은 keychain(Rust) — 미노출.

/** 프로젝트별 Gmail 연결 상태(hasClient/connected/detail). 토큰/이메일 본문 미노출. */
export function useGmailStatus(projectId: string) {
  return useQuery({
    queryKey: ["gmailStatus", projectId],
    queryFn: () => unwrap(commands.gmailStatus(projectId)),
    enabled: !!projectId,
  });
}

/** Gmail OAuth client(client_id/secret) 저장. 본문은 IPC 인자로만 전달, 캐시 미저장. */
export function useSetGmailOauthClient() {
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
    }) => unwrap(commands.setGmailOauthClient(projectId, clientId, clientSecret)),
    onSuccess: (_data, v) => qc.invalidateQueries({ queryKey: ["gmailStatus", v.projectId] }),
  });
}

/** loopback + PKCE OAuth 실행(브라우저 동의 → refresh_token keychain 저장). bounded timeout. */
export function useStartGmailOauth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.startGmailOauth(projectId)),
    onSuccess: (_data, projectId) => qc.invalidateQueries({ queryKey: ["gmailStatus", projectId] }),
  });
}

/** 진행 중인 loopback OAuth 대기를 취소한다. */
export function useCancelGmailOauth() {
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.cancelGmailOauth(projectId)),
  });
}

/** 연결 해제(keychain blob 삭제). */
export function useDisconnectGmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.disconnectGmail(projectId)),
    onSuccess: (_data, projectId) => qc.invalidateQueries({ queryKey: ["gmailStatus", projectId] }),
  });
}
