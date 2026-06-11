/**
 * working 세션 키의 클라이언트 first-seen(ms) 외부 레지스트리 — 표시 전용(INVARIANT #1).
 *
 * 백엔드 timestamp가 없는 세션(hermes 탭/cmux 워크스페이스)의 경과 표시 기준점.
 * React state가 아니라 외부 스토어인 이유: Date.now() 스탬프는 impure라 render에 못 두고,
 * effect 내 동기 setState로 반영하면 React Compiler가 컴포넌트를 통째로 skip한다
 * (set-state-in-effect). useSyncExternalStore 구독 + effect에서 setState 없이 reconcile
 * 하는 구성은 같은 의미를 컴파일러 친화적으로 유지한다.
 *
 * 모듈 스코프라 바 unmount/remount에도 first-seen이 보존된다(이전 useState 구현은 리셋).
 */

type Snapshot = ReadonlyMap<string, number>;

let snapshot: Snapshot = new Map();
const listeners = new Set<() => void>();

export function subscribeFirstSeen(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getFirstSeenSnapshot(): Snapshot {
  return snapshot;
}

/**
 * desired = 지금 working인 세션 키 집합. 신규 키는 now로 스탬프, 사라진 키는 정리.
 * 변경 없으면 snapshot 참조를 유지해 구독자 리렌더 0 (기존 함수형 updater의
 * `return changed ? next : prev`와 동일 의미).
 */
export function reconcileFirstSeen(desired: ReadonlySet<string>): void {
  let changed = false;
  const next = new Map(snapshot);
  const now = Date.now();
  for (const k of desired) {
    if (!next.has(k)) {
      next.set(k, now);
      changed = true;
    }
  }
  for (const k of next.keys()) {
    if (!desired.has(k)) {
      next.delete(k);
      changed = true;
    }
  }
  if (!changed) return;
  snapshot = next;
  for (const l of listeners) l();
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetFirstSeenForTest(): void {
  snapshot = new Map();
}
