// 사분면/영역 닫힌 세트 옵션 + Select 미설정 센티넬 — 단일 정본.
// JobsView 패널(EnrichPanel/BatchEnrichPanel)과 전역 AgentRunModal이 공유.
// (INVARIANT #1: codex 자동 분류 아님 — accept 시 사람이 닫힌 세트에서 확정.)
import type { AgentStatus, AreaTag, Quadrant } from "@/bindings";

/**
 * radix Select 미설정 센티넬 — radix Select는 빈 문자열 value를 허용하지 않는다.
 * `null` 영역을 select value로 표현할 때만 사용(저장 시 다시 null로 변환).
 */
export const AREA_NONE = "__none__";

/** 사분면 닫힌 세트 옵션(accept 시 사람 확정 — INVARIANT #1). */
export const QUADRANT_OPTS: { value: Quadrant; label: string }[] = [
  { value: "unclassified", label: "미분류" },
  { value: "q1_do_now", label: "Q1 지금" },
  { value: "q2_schedule", label: "Q2 일정" },
  { value: "q3_quick_contain", label: "Q3 빠르게" },
  { value: "q4_drop", label: "Q4 버림" },
];

/** 라이프 도메인 옵션(닫힌 taxonomy). */
export const AREA_OPTS: { value: AreaTag; label: string }[] = [
  { value: "health", label: "건강" },
  { value: "work", label: "업무" },
  { value: "studies", label: "학습" },
  { value: "environment", label: "환경" },
  { value: "recreation", label: "휴식" },
  { value: "romance", label: "연애" },
  { value: "family", label: "가족" },
  { value: "finances", label: "재정" },
  { value: "friends", label: "친구" },
  { value: "other", label: "기타" },
];

/** 잡 상태 → 라벨/색 클래스 (PR Radar 버킷 톤 재사용). */
export const JOB_STATUS: Record<AgentStatus, { label: string; cls: string }> = {
  proposed: { label: "큐 대기", cls: "jobs-st-proposed" },
  awaiting_approval: { label: "승인 대기", cls: "jobs-st-proposed" },
  running: { label: "실행 중", cls: "jobs-st-running" },
  succeeded: { label: "완료", cls: "jobs-st-succeeded" },
  failed: { label: "실패", cls: "jobs-st-failed" },
  cancelled: { label: "취소됨", cls: "jobs-st-cancelled" },
};

export function isActiveJobStatus(status: AgentStatus): boolean {
  return status === "running" || status === "proposed" || status === "awaiting_approval";
}

/** 사용자가 ack(닫기)할 수 있는 최종 종료 상태. awaiting_approval은 여전히 액션 가능 → 제외. */
export function isFinishedJobStatus(status: AgentStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
