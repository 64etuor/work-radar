import { useEffect, useRef } from "react";

import { eventToHotkeySpec } from "@/lib/hotkey";

/**
 * 메뉴별 키보드 단축키 적용 (Phase 18 #7). keymap(action→shortcut)을 받아 전역 keydown에서
 * 매칭되면 onAction(actionKey)를 부른다. actionKey는 보통 view지만 "calendar" 같은 액션도 가능.
 *
 * 두 포맷을 함께 지원한다:
 *   - **조합 단축키**(현 기본): "Cmd+1" / "Ctrl+Shift+K" — modifier 동반. 입력 포커스에서도 동작
 *     (조합키는 타이핑과 충돌하지 않음). eventToHotkeySpec로 spec 생성해 정확 매칭.
 *   - **레거시 단일/체인**: "1" / "g b" — modifier 없음. 입력 포커스 시 비활성(타이핑 보존),
 *     체인은 1초 내 두 번째 키. (예전에 저장한 keymap 호환용.)
 *
 * Cmd/Ctrl+←/→: NAV 순서 기준 인접 뷰 전환(onAdjacent). 빈 문자열 단축키는 무시(그 액션 비활성).
 */

const CHORD_TIMEOUT_MS = 1000;

function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (node.isContentEditable) return true;
  return false;
}

/** keydown → 정규화된 단일 키 토큰(소문자 단일 문자/심볼). 레거시 경로 전용. */
function normalizeKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k.length === 1) return k.toLowerCase();
  return null;
}

export function useViewShortcuts(
  keymap: Record<string, string> | undefined,
  enabled: boolean,
  onAction: (actionKey: string) => void,
  onAdjacent?: (dir: -1 | 1) => void,
) {
  // 최신 props를 keydown 리스너에서 안전하게 읽기 위한 ref. keydown은 항상 commit 이후
  // 발생하므로 effect로 동기화해도 stale 위험이 없다(react-hooks/refs).
  const onActionRef = useRef(onAction);
  const onAdjacentRef = useRef(onAdjacent);
  const keymapRef = useRef(keymap);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    onActionRef.current = onAction;
    onAdjacentRef.current = onAdjacent;
    keymapRef.current = keymap;
    enabledRef.current = enabled;
  });

  useEffect(() => {
    let prefix: string | null = null;
    let timer: number | undefined;
    const clearPrefix = () => {
      prefix = null;
      window.clearTimeout(timer);
    };

    /** keymap에서 spec(대소문자 무시)과 정확히 일치하는 액션 키를 찾는다. */
    const findExact = (combo: string): string | null => {
      const map = keymapRef.current;
      if (!map) return null;
      const lower = combo.toLowerCase();
      const hit = Object.entries(map).find(
        ([, sc]) => sc.trim() !== "" && sc.trim().toLowerCase() === lower,
      );
      return hit ? hit[0] : null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;

      // Cmd/Ctrl+←/→ → 인접 뷰 전환(alt/shift 동반 시 무시 — OS 단어 이동 등 보존).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          clearPrefix();
          onAdjacentRef.current?.(e.key === "ArrowLeft" ? -1 : 1);
          return;
        }
      }

      // 1) 조합 단축키(modifier 동반) — 입력 포커스에서도 동작(조합키는 타이핑과 무관).
      if (e.metaKey || e.ctrlKey || e.altKey) {
        const spec = eventToHotkeySpec(e);
        if (!spec) return;
        const action = findExact(spec);
        if (action) {
          e.preventDefault();
          clearPrefix();
          onActionRef.current(action);
        }
        return;
      }

      // 2) 레거시 단일/체인(modifier 없음) — 입력 포커스 시 비활성.
      if (isEditableTarget(e.target)) return;
      const map = keymapRef.current;
      if (!map) return;
      const key = normalizeKey(e);
      if (!key) return;

      const combo = prefix ? `${prefix} ${key}` : key;
      const exact = findExact(combo);
      if (exact) {
        e.preventDefault();
        clearPrefix();
        onActionRef.current(exact);
        return;
      }

      // 이 키가 어떤 체인의 prefix(첫 토큰)인가? → prefix 보류.
      const isPrefix = Object.values(map).some((sc) => {
        const parts = sc.trim().toLowerCase().split(/\s+/);
        return parts.length === 2 && parts[0] === key && !prefix;
      });
      if (isPrefix) {
        e.preventDefault();
        prefix = key;
        window.clearTimeout(timer);
        timer = window.setTimeout(clearPrefix, CHORD_TIMEOUT_MS);
        return;
      }

      clearPrefix();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timer);
    };
  }, []);
}
