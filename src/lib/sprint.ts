/**
 * 스프린트 카운트다운 순수 헬퍼 (P11). 헤더 1s tick의 표시 로직 — DESIGN.md `sprint-timer` 정본.
 *
 * 경계 계산(다음 경계)의 SSOT는 **Rust `next_boundary`**(직접 구현 + cargo test, rrule 미사용).
 * 프런트는 그 경계 RFC3339 문자열을 받아 **로컬 시계로 매초 남은 시간을 재계산·포맷**만 한다
 * (1s tick은 표시 갱신일 뿐 — drift는 경계가 절대시각이 아니라 Rust가 매번 anchor+interval로 계산해 없음).
 */

/** 카운트다운 표시 상태. overdue면 색(Coral)+라벨 병기(DESIGN: 색만으로 의미 금지). */
export type CountdownDisplay = {
  /** 'D일 HH:MM' (overdue면 절댓값). */
  text: string;
  /** 'D일'만(좁은 폭 반응형). */
  compact: string;
  /** 경계를 지났는가(remaining < 0). true면 Coral + '지남' 라벨. */
  overdue: boolean;
};

const SEC_PER_MIN = 60;
const SEC_PER_HOUR = 3600;
const SEC_PER_DAY = 86_400;

/**
 * 경계 RFC3339(로컬 오프셋 포함) 문자열과 현재 시각(ms)으로 남은 초를 구한다(음수=overdue).
 * Date 파싱이 절대 인스턴트로 정규화하므로 로컬/오프셋이 달라도 일관(표시 tick 용도).
 * 파싱 실패면 null(호출자가 empty 처리).
 */
export function remainingSecondsUntil(
  boundaryRfc3339: string,
  nowMs: number = Date.now(),
): number | null {
  const t = Date.parse(boundaryRfc3339);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - nowMs) / 1000);
}

/** 두 자리 0 패딩. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 남은 초 → 'D일 HH:MM' 표시. overdue(음수)면 절댓값으로 같은 포맷 + overdue 플래그.
 * 분 단위 표시(DESIGN: 분 단위 갱신) — 초는 버린다. compact은 'D일'만.
 */
export function formatCountdown(remainingSeconds: number): CountdownDisplay {
  const overdue = remainingSeconds < 0;
  const abs = Math.abs(remainingSeconds);
  const days = Math.floor(abs / SEC_PER_DAY);
  const hours = Math.floor((abs % SEC_PER_DAY) / SEC_PER_HOUR);
  const mins = Math.floor((abs % SEC_PER_HOUR) / SEC_PER_MIN);
  return {
    text: `${days}일 ${pad2(hours)}:${pad2(mins)}`,
    compact: `${days}일`,
    overdue,
  };
}

/** 헤더 문구: 시간 단위까지 유지한다. 다음 경계는 Rust가 다음 스프린트로 넘겨준다. */
export function formatCountdownLabel(display: CountdownDisplay): string {
  return `${display.text} 남음`;
}

/** 요일 코드 → 한국어 라벨(에디터 표시). bindings의 Weekday(snake_case)와 동일 키. */
export const WEEKDAY_LABELS: Record<string, string> = {
  mon: "월",
  tue: "화",
  wed: "수",
  thu: "목",
  fri: "금",
  sat: "토",
  sun: "일",
};
