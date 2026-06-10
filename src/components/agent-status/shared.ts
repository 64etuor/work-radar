import type { Engine } from "@/bindings";
import type { BoxState } from "@/lib/agentBar";

/** 세션 1개 = 박스 1개의 표시 모델(표시 전용, 결정 미사용). */
export type SessionBox = {
  key: string;
  engine: Engine;
  name: string;
  state: BoxState;
  /** 상태 라벨(색+텍스트 병기 — 색만으로 의미 전달 금지). */
  stateLabel: string;
  /** epoch ms — 백엔드 startedAt(codex) 또는 client first-seen(hermes/cmux). null이면 idle. */
  startedMs: number | null;
  /** codex 잡 timeout(초). 없는 세션은 null → 경과만으로 포화. */
  timeoutSec: number | null;
  title: string;
};

export const STATE_LABEL: Record<BoxState, string> = {
  idle: "대기",
  working: "작업 중",
  waiting: "입력 대기",
  error: "오류",
  done: "완료",
};
