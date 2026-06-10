/**
 * 전역 keydown 단일 버스 (ADR-0011 후속 ②).
 *
 * 종전엔 window keydown 리스너 4곳(HermesView / App 셸 / useViewShortcuts / useCmdKnob)이
 * "React 마운트 순서(자식 effect가 부모보다 먼저)"라는 암묵 계약으로 실행 순서를 정하고,
 * HermesView가 stopImmediatePropagation으로 소비를 표현했다 — 등록 순서가 리렌더/재등록
 * 타이밍에 따라 흘러내릴 수 있는 잠재 결함(HermesView의 "마지막 등록" 주석은 전제부터
 * 틀렸었다). 이제 우선순위를 여기서 명시한다.
 *
 * 계약: 핸들러가 `true`를 반환하면 **소비** — 이후(낮은 우선순위) 핸들러로 전파하지 않는다.
 * void/false는 통과. 같은 우선순위끼리는 등록 순(FIFO). preventDefault는 각 핸들러 소관.
 */
export type KeydownHandler = (e: KeyboardEvent) => boolean | void;

export const KEYDOWN_PRIORITY = {
  /**
   * knob 트리거 모디파이어 감시(dwell arming 전용) — **관찰 전용**(절대 소비하지 않음).
   * 최상위인 이유: 비모디파이어 keydown이 arming 취소 신호라, 다른 핸들러(Hermes 등)가
   * 소비하는 키도 종전(모든 리스너가 모든 이벤트를 보던 시절)처럼 봐야 한다.
   */
  knobWatch: 400,
  /** Hermes 패널 단축키(⌘N/W/1–9, 패널 열림일 때만 매칭) — 매칭 시 소비. */
  hermes: 300,
  /** App 셸 하드코딩(Cmd+K 팔레트 토글, Esc 계층). 소비하지 않음(종전 동치). */
  shell: 200,
  /** keymap 단축키(useViewShortcuts — 조합/레거시 체인/인접 네비). 소비하지 않음. */
  keymap: 100,
} as const;

interface Entry {
  priority: number;
  seq: number;
  fn: KeydownHandler;
}

let entries: Entry[] = [];
let seq = 0;
let attached = false;

/** 버스 한 틱 — 우선순위 내림차순(동순위 FIFO) 순회, true 반환 시 중단. (테스트에서 직접 호출 가능.) */
export function dispatchKeydown(e: KeyboardEvent): void {
  // 스냅샷 순회 — 핸들러가 도중에 등록/해제해도 이번 틱은 안전.
  for (const entry of [...entries]) {
    if (entry.fn(e) === true) return;
  }
}

function onWindowKeydown(e: KeyboardEvent): void {
  dispatchKeydown(e);
}

/** keydown 핸들러 등록. 반환된 함수로 해제. 첫 등록 시 window에 1회 attach, 모두 해제되면 detach. */
export function registerKeydown(priority: number, fn: KeydownHandler): () => void {
  const entry: Entry = { priority, seq: seq++, fn };
  entries = [...entries, entry].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  if (!attached && typeof window !== "undefined") {
    window.addEventListener("keydown", onWindowKeydown);
    attached = true;
  }
  return () => {
    entries = entries.filter((x) => x !== entry);
    if (entries.length === 0 && attached) {
      window.removeEventListener("keydown", onWindowKeydown);
      attached = false;
    }
  };
}
