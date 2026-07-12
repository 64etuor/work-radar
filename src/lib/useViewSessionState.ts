/**
 * 뷰-세션 상태 — `useState` 드롭인 대체. 값을 모듈-레벨 Map에 미러해 **뷰 전환에도 살아남는다**
 * (App.tsx가 뷰를 컴포넌트 타입 스왑 + key={view}로 통째 리마운트하므로 view-local useState는
 * 매 전환마다 초기화된다 — 선택/기간/필터가 날아가는 UX 마찰의 근원).
 *
 * 의미론: **세션 한정** — 앱 재시작 시 초기값으로 리셋된다. 재시작 후에도 유지할 *선호도*는
 * localStorage 패턴(`useStickyToggle`, bookkeepingTabs)을 쓰고, 이 훅은 "보던 자리"용이다.
 * 오버레이 열림/드래그 중간값 같은 진짜 휘발 상태에는 쓰지 않는다.
 */
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

const sessionValues = new Map<string, unknown>();

export function useViewSessionState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (sessionValues.has(key)) return sessionValues.get(key) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  // 커밋된 값만 미러(updater를 순수하게 유지 — StrictMode 이중 호출과 무관하게 안전).
  useEffect(() => {
    sessionValues.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

/** 테스트 전용 — 모듈 세션 값 전체 초기화. */
export function resetViewSessionStateForTest(): void {
  sessionValues.clear();
}
