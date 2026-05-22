import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import {
  commands,
  type DetectedChat,
  type HermesBridgeStatus,
  type HermesFetchResult,
  type HermesMessage,
} from "@/bindings";

// Hermes 메신저 브리지 (Phase 20 #15). 봇 토큰은 keychain(Rust) — 본문은 IPC 인자로만 전달, 캐시 미저장.
// 수신은 bounded 단발 fetch(무한 long-poll 아님) — cadence는 사용자 버튼/뷰 폴링이 정한다(#5).

/** 브리지 연결 상태(configured/chat_id). 봇 토큰 본문 미노출. */
export function useHermesBridgeStatus() {
  return useQuery<HermesBridgeStatus>({
    queryKey: ["hermesBridgeStatus"],
    queryFn: () => unwrap(commands.hermesBridgeStatus()),
    staleTime: 30_000,
  });
}

/** 브리지 설정(봇 토큰 → keychain, chat_id 저장). 본문은 IPC 인자로만, 캐시 미저장. */
export function useSetHermesBridge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botToken, chatId }: { botToken: string; chatId: string }) =>
      unwrap(commands.setHermesBridge(botToken, chatId)),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["hermesBridgeStatus"] }),
  });
}

/** 연결 해제(keychain 토큰 + 설정 행 삭제). 메시지 로그는 보존. */
export function useDisconnectHermes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.disconnectHermes()),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["hermesBridgeStatus"] }),
  });
}

/** 제어 surface용 메시지 로그(오래된→최신, bounded). */
export function useHermesMessages(limit = 200) {
  return useQuery<HermesMessage[]>({
    queryKey: ["hermesMessages", limit],
    queryFn: () => unwrap(commands.listHermesMessages(limit)),
    staleTime: 5_000,
  });
}

/** Hermes에게 명령 전송(sendMessage). 성공 시 메시지 로그 무효화(송신 카드 반영). */
export function useSendHermesMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => unwrap(commands.sendHermesMessage(text)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hermesMessages"] }),
  });
}

/** 새 메시지 bounded 단발 수신(getUpdates). 받은 수를 반환, 로그 무효화. 무한 poll 아님(#5). */
export function useFetchHermesMessages() {
  const qc = useQueryClient();
  return useMutation<HermesFetchResult, Error, void>({
    mutationFn: () => unwrap(commands.fetchHermesMessages()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hermesMessages"] }),
  });
}

/**
 * getUpdates 단발 호출로 실 사용자 chat_id를 감지한다.
 * botToken: 현재 입력 중인 토큰(저장 전에도 동작). null이면 keychain에서 읽음.
 * 봇 토큰 본문은 캐시·반환에 절대 담기지 않는다(INVARIANT). chat_id+label만 반환.
 */
export function useDetectHermesChatId() {
  return useMutation<DetectedChat, Error, string | null>({
    mutationFn: (botToken) =>
      unwrap(commands.detectHermesChatId(botToken)),
  });
}
