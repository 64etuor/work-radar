import { useCallback, useEffect, useRef } from "react";

/**
 * `fn`을 마지막 호출 기준 `delay`ms 뒤에만 실행하는 콜백을 돌려준다. 잇따른 호출은 타이머를
 * 재시작한다. unmount 시 pending 타이머는 정리한다.
 *
 * `flushNow`는 현재 pending 타이머를 취소하고 인자를 즉시 적용한다 — "즉시 저장" 액션
 * (프리셋 클릭/리셋 등)과 "타이핑 중 디바운스"를 한 함수 페어로 다룰 때 쓴다.
 *
 * 호출자가 매 렌더 새 함수를 넘기더라도 최신 클로저가 timeout에서 보이도록 `fnRef`로 핀한다.
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): { run: (...args: A) => void; flushNow: (...args: A) => void; cancel: () => void } {
  const fnRef = useRef(fn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 매 렌더 후 최신 fn 핀(write-in-render 금지 — react-hooks/refs). 첫 firing은 commit 이후이므로
  // 사용자 이벤트로 트리거되는 run/flushNow는 항상 최신 클로저를 본다.
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(
    (...args: A) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        fnRef.current(...args);
      }, delay);
    },
    [delay],
  );

  const flushNow = useCallback((...args: A) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    fnRef.current(...args);
  }, []);

  return { run, flushNow, cancel };
}
