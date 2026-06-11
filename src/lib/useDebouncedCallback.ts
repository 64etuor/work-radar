import { useEffect, useRef } from "react";

/**
 * `fn`을 마지막 호출 기준 `delay`ms 뒤에만 실행하는 콜백을 돌려준다. 잇따른 호출은 타이머를
 * 재시작한다. unmount 시 pending 타이머가 남아 있으면 마지막 인자로 **flush**한다 — 키 변경
 * (예: 프로젝트 전환으로 카드 언마운트)으로 디바운스 도중 컴포넌트가 사라져도 마지막 입력이
 * 유실되지 않게 한다. `cancel()`로 비운 경우(타이머 null)엔 flush 대상이 없다.
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
  // 현재 pending 타이머의 마지막 인자. unmount flush가 참조한다. 타이머가 없으면 null.
  const pendingArgsRef = useRef<A | null>(null);

  // 매 렌더 후 최신 fn 핀(write-in-render 금지 — react-hooks/refs). 첫 firing은 commit 이후이므로
  // 사용자 이벤트로 트리거되는 run/flushNow는 항상 최신 클로저를 본다.
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    return () => {
      // unmount 시 pending이 있으면 버리지 않고 마지막 인자로 flush(데이터 유실 방지).
      const timer = timerRef.current;
      if (timer !== null) {
        clearTimeout(timer);
        timerRef.current = null;
        if (pendingArgsRef.current !== null) {
          const args = pendingArgsRef.current;
          pendingArgsRef.current = null;
          fnRef.current(...args);
        }
      }
    };
  }, []);

  const cancel = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingArgsRef.current = null;
  };

  const run = (...args: A) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    pendingArgsRef.current = args;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingArgsRef.current = null;
      fnRef.current(...args);
    }, delay);
  };

  const flushNow = (...args: A) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingArgsRef.current = null;
    fnRef.current(...args);
  };

  return { run, flushNow, cancel };
}
