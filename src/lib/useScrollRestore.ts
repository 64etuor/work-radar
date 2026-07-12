/**
 * 뷰 스크롤 복원 — 뷰 전환 리마운트로 각 뷰의 스크롤 컨테이너 scrollTop이 0으로 리셋되는 것을
 * 모듈-레벨 Map으로 복원한다. 반환된 ref 콜백을 뷰의 스크롤 루트에 단다.
 *
 * 저장은 passive scroll 리스너로 연속 기록 — unmount 시점의 DOM 상태에 의존하지 않는다
 * (App.tsx 전환 스냅샷과 무관하게 안전). 복원은 attach 시 1회: 데이터가 캐시/persist로 동기
 * 페인트되는 뷰에서 정확하고, 콘텐츠가 아직 짧으면 브라우저가 최대치로 클램프한다(무해).
 * 세션 한정(재시작 리셋). TodayView 타임라인은 의도적으로 "지금"에 재센터링하므로 비대상.
 */
import { type RefCallback, useCallback } from "react";

const scrollTops = new Map<string, number>();

export function useScrollRestore(key: string): RefCallback<HTMLElement> {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const saved = scrollTops.get(key);
      if (saved) el.scrollTop = saved;
      const onScroll = () => scrollTops.set(key, el.scrollTop);
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => el.removeEventListener("scroll", onScroll);
    },
    [key],
  );
}

/** 테스트 전용 — 저장된 스크롤 위치 전체 초기화. */
export function resetScrollRestoreForTest(): void {
  scrollTops.clear();
}
