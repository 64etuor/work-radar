import { isKnobKeymapKey, NAV_BY_VIEW } from "@/lib/nav";
import type { View } from "@/store";

/**
 * 앱 전역 단축키/knob이 발사하는 **일급 액션**(ADR-0011). 종전에는 knob fire가 합성
 * KeyboardEvent를 window에 쏘고 useViewShortcuts가 문자열로 되-매칭하는 사이드채널이라
 * 자기-매칭(knob_up="Cmd+Up")·리스너 순서 의존·키 라벨 왕복("Left"↔"ArrowLeft") 같은
 * 유닛-사이 버그가 살았다. 이제 콤보는 여기서 한 번 AppAction으로 해석되고, 실행은
 * App.dispatchAction 단일 chokepoint로 직행한다 — 타입 안전 + 경로 결정적.
 */
export type AppAction =
  | { kind: "navigate"; view: View }
  | { kind: "adjacent"; dir: -1 | 1 }
  | { kind: "toggle-calendar" }
  | { kind: "toggle-inbox" };

/**
 * keymap에서 combo spec과 정확히 일치하는 **액션 키**를 찾는다(대소문자 무시). knob 예약 키
 * (knob_up/down/left/right/trigger)는 제외 — 그 값은 knob이 발사할 콤보지 액션 바인딩이
 * 아니라서, 포함하면 knob 방향 fire가 자기 자신과 매칭된다(isKnobKeymapKey doc). 순수 함수.
 */
export function findKeymapAction(
  map: Record<string, string> | undefined,
  combo: string,
): string | null {
  if (!map) return null;
  const lower = combo.trim().toLowerCase();
  if (!lower) return null;
  const hit = Object.entries(map).find(
    ([k, sc]) => !isKnobKeymapKey(k) && sc.trim() !== "" && sc.trim().toLowerCase() === lower,
  );
  return hit ? hit[0] : null;
}

/**
 * keymap 액션 키 → AppAction. 등록된 view/액션만 인정 — 그 외(과거 제거된 view가 저장
 * keymap에 남은 경우 등)는 null. 무효 키가 View로 캐스팅돼 store view를 오염시키던
 * 경로를 타입 레벨에서 차단한다.
 */
export function actionForKeymapKey(key: string): AppAction | null {
  if (key === "calendar") return { kind: "toggle-calendar" };
  if (key === "inbox") return { kind: "toggle-inbox" };
  if (key in NAV_BY_VIEW) return { kind: "navigate", view: key as View };
  return null;
}

/**
 * combo spec("Cmd+Left"/"Cmd+1") → AppAction. 인접 네비(Cmd/Ctrl+←/→)는 keymap이 아닌
 * 하드코딩 단축키라 먼저 본다 — 런타임 keydown 매처(useViewShortcuts)와 동일한 우선순위.
 * 그 외엔 keymap 액션 키를 찾아 actionForKeymapKey로. 매칭 없으면 null(no-op).
 */
export function resolveCombo(
  map: Record<string, string> | undefined,
  spec: string,
): AppAction | null {
  const lower = spec.trim().toLowerCase();
  if (lower === "cmd+left" || lower === "ctrl+left") return { kind: "adjacent", dir: -1 };
  if (lower === "cmd+right" || lower === "ctrl+right") return { kind: "adjacent", dir: 1 };
  const key = findKeymapAction(map, spec);
  return key ? actionForKeymapKey(key) : null;
}
