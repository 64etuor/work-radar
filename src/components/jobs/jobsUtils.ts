/** SQLite UTC datetime('YYYY-MM-DD HH:MM:SS') → epoch ms (runToBox.ts와 동일 포맷). */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 종료된 잡의 실제 실행 시간(초). started/finished 둘 다 있어야 산출(아니면 null).
 * 표시 전용 — 시계 불요(정적 타임스탬프 차)라 render에서 순수 호출 가능.
 */
export function runDurationSec(startedAt: string | null, finishedAt: string | null): number | null {
  const start = parseUtcMs(startedAt);
  const end = parseUtcMs(finishedAt);
  if (start == null || end == null || end < start) return null;
  return (end - start) / 1000;
}

/**
 * 스크롤 위치가 "바닥 근처"인지(= 로그 follow 유지 대상). 임계 40px — 마지막 줄 부분
 * 가림/서브픽셀 오차 허용. 순수 함수(LogPane onScroll에서 호출, 단위테스트 대상).
 */
export function isPinnedToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx = 40,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

/** run.trigger(JSON)에서 PR 링크 정보 추출 (없으면 null). */
export function prTrigger(
  trigger: string | null,
): { prUrl: string; repoFullName: string; prNumber: number } | null {
  if (!trigger) return null;
  try {
    const v = JSON.parse(trigger);
    if (typeof v?.prUrl === "string") return v;
  } catch {
    /* 무시 — 트리거 없는 잡. */
  }
  return null;
}
