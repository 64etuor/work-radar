import { useEffect, useRef, useState } from "react";

import { isOverlayOpen } from "@/components/ui/overlay-stack";
import { type AppAction, resolveCombo } from "@/lib/appActions";
import type { KnobDir } from "@/lib/knobGeometry";
import { KNOB_DIRECTIONS, KNOB_TRIGGER_DEFAULT, KNOB_TRIGGER_KEY } from "@/lib/nav";
import { useNavKeymap } from "@/lib/query";

const DWELL_MS = 300;
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

type TriggerMods = { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

/** "Cmd+Shift" 류 트리거 spec → 모디파이어 집합. 빈 값/무효는 Cmd 단독으로 폴백. (테스트용 export) */
export function parseTrigger(spec: string | undefined): TriggerMods {
  const mods: TriggerMods = { ctrl: false, meta: false, alt: false, shift: false };
  const parts = (spec && spec.trim() ? spec : KNOB_TRIGGER_DEFAULT)
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const p of parts) {
    if (p === "ctrl") mods.ctrl = true;
    else if (p === "cmd" || p === "meta") mods.meta = true;
    else if (p === "alt") mods.alt = true;
    else if (p === "shift") mods.shift = true;
  }
  if (!mods.ctrl && !mods.meta && !mods.alt && !mods.shift) mods.meta = true;
  return mods;
}

/** 이벤트의 현재 모디파이어 상태가 트리거와 정확히 일치하는가(추가 모디파이어 없음). (테스트용 export) */
export function modsExactlyMatch(
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  t: TriggerMods,
): boolean {
  return (
    e.ctrlKey === t.ctrl && e.metaKey === t.meta && e.altKey === t.alt && e.shiftKey === t.shift
  );
}

function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!node.isContentEditable;
}

export interface CmdKnobState {
  visible: boolean;
  origin: { x: number; y: number };
  dirEnabled: Record<KnobDir, boolean>;
  /** 방향 발사: 그 방향에 설정된 combo를 AppAction으로 해석해 dispatch. 미설정/해석 불가면 no-op. */
  fire: (dir: KnobDir) => void;
}

/**
 * 트리거 모디파이어 단독 hold(~300ms dwell) → 커서 위치에 knob을 띄운다.
 * dwell 중 비-모디파이어 키/추가 모디파이어가 오면 그 hold 세션 취소(기존 조합키 무손상).
 * visible 이후엔 키로 취소하지 않는다 — 자기 합성 발사에 스스로 닫히지 않도록(설계 §3).
 * 트리거 release로만 종료.
 *
 * dispatch: App의 dispatchAction. 방향 fire는 합성 KeyboardEvent 왕복 없이 콤보를
 * resolveCombo로 해석해 인프로세스 직행한다(ADR-0011 — 자기-매칭/리스너 순서 의존 제거).
 */
export function useCmdKnob(dispatch: (action: AppAction) => void): CmdKnobState {
  const keymap = useNavKeymap();
  const [visible, setVisible] = useState(false);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });

  // 리스너에서 안전하게 읽을 최신값 ref.
  const keymapRef = useRef(keymap.data);
  // 초기값 = 뷰포트 중앙: 앱 시작/리로드 후 mousemove가 한 번도 없으면 (0,0)이라 knob이
  // 좌상단 구석에 스폰되던 결함 방지(첫 mousemove부터는 실제 커서 추적).
  const pointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const visibleRef = useRef(false);
  const dwellTimerRef = useRef<number | null>(null);
  const downNonModRef = useRef(false);
  useEffect(() => {
    keymapRef.current = keymap.data;
  });
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const dirEnabled: Record<KnobDir, boolean> = {
    up: !!(keymap.data?.knob_up ?? "").trim(),
    down: !!(keymap.data?.knob_down ?? "").trim(),
    left: !!(keymap.data?.knob_left ?? "").trim(),
    right: !!(keymap.data?.knob_right ?? "").trim(),
  };

  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  });

  const fire = (dir: KnobDir) => {
    const map = keymapRef.current;
    const key = KNOB_DIRECTIONS.find((d) => d.dir === dir)?.key;
    const combo = (key ? (map?.[key] ?? "") : "").trim();
    if (!combo) return;
    const action = resolveCombo(map, combo);
    if (action) dispatchRef.current(action);
  };

  useEffect(() => {
    const cancelDwell = () => {
      if (dwellTimerRef.current !== null) {
        window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // visible: 키 무시(자기-발사 자기-취소 방지). 트리거 release는 keyup에서만 처리.
      if (visibleRef.current) return;

      const trigger = parseTrigger(keymapRef.current?.[KNOB_TRIGGER_KEY]);

      if (!MODIFIER_KEYS.has(e.key)) {
        // 비-모디파이어 키 → arming 취소(Cmd+K 등 기존 조합 무손상).
        downNonModRef.current = true;
        cancelDwell();
        return;
      }

      // 모디파이어 keydown: 지금 눌린 모디파이어가 트리거와 정확히 일치 + 비모디파이어 키 없음 → dwell 시작.
      if (!downNonModRef.current && modsExactlyMatch(e, trigger)) {
        cancelDwell();
        dwellTimerRef.current = window.setTimeout(() => {
          dwellTimerRef.current = null;
          if (isOverlayOpen() || isEditableTarget(document.activeElement)) return;
          setOrigin(pointerRef.current);
          setVisible(true);
        }, DWELL_MS);
      } else {
        cancelDwell();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(e.key)) {
        // 모든 비-모디파이어가 떼어졌다고 가정할 순 없지만, 단순화: 비모디파이어 up이면 플래그 해제.
        downNonModRef.current = false;
        return;
      }
      const trigger = parseTrigger(keymapRef.current?.[KNOB_TRIGGER_KEY]);
      // 모디파이어를 떼서 더 이상 트리거와 일치하지 않으면 dwell 취소 / knob 해제.
      if (!modsExactlyMatch(e, trigger)) {
        cancelDwell();
        if (visibleRef.current) setVisible(false);
      }
    };

    // 포커스 상실/창 비활성/탭 전환(Cmd+Tab 등) — 모디파이어 keyup을 놓쳐도 knob이 갇히지 않게.
    const onBlur = () => {
      cancelDwell();
      downNonModRef.current = false;
      if (visibleRef.current) setVisible(false);
    };
    const onVisibility = () => {
      if (document.hidden) onBlur();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelDwell();
    };
  }, []);

  return { visible, origin, dirEnabled, fire };
}
