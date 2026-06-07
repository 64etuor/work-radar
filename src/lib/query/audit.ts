import { useMutation } from "@tanstack/react-query";

import { commands, type ConnectionAudit } from "@/bindings";

import { unwrap } from "./client";

/**
 * 전 프로젝트 연결 점검(on-demand). 버튼으로 트리거하는 읽기 전용 헬스체크 —
 * 토큰/Notion DB/Google/Gmail 연결 검증 + 중복/환경 경고를 한 번에 받는다.
 */
export function useConnectionAudit() {
  return useMutation<ConnectionAudit, Error, void>({
    mutationFn: () => unwrap(commands.runConnectionAudit()),
  });
}
