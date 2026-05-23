import { useEffect, useRef } from "react";

import type { View } from "@/store";

/**
 * per-view 키보드 단축키 적용 (Phase 18 #7). keymap(view→shortcut)을 받아 전역 keydown에서
 * 매칭되면 onJump(view)를 부른다. 입력 포커스(input/textarea/select/contenteditable)에서는
 * 비활성 — Cmd+K 팔레트/타이핑과 충돌하지 않게.
 *
 * modifier 정책:
 *   - chord/단일 키 단축키: meta/ctrl/alt 동반 시 비활성(타이핑·OS 단축키 보존).
 *   - Cmd+←/→ (mac) / Ctrl+←/→: 인접 뷰 전환(P3). meta||ctrl 일 때만 처리.
 *
 * 지원 형식:
 *   - 단일 키: "1" / "b"            (해당 키 단독 입력)
 *   - chord  : "g b" / "g ,"        (선행 키 누른 뒤 1초 내 다음 키)
 * 빈 문자열 단축키는 무시(그 view 비활성).
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

/** keydown → 정규화된 키 토큰(소문자 단일 문자/심볼). 매칭 키만 다룬다. */
function normalizeKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k.length === 1) return k.toLowerCase();
  return null;
}

export function useViewShortcuts(
  keymap: Record<string, string> | undefined,
  enabled: boolean,
  onJump: (view: View) => void,
  onAdjacent?: (dir: -1 | 1) => void,
) {
  // 콜백/맵을 ref로 들고 effect 재구독을 막는다(매 키 입력마다 최신 참조 사용).
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const onAdjacentRef = useRef(onAdjacent);
  onAdjacentRef.current = onAdjacent;
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    // pending chord prefix(예: "g") + 만료 타이머.
    let prefix: string | null = null;
    let timer: number | undefined;

    const clearPrefix = () => {
      prefix = null;
      window.clearTimeout(timer);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (isEditableTarget(e.target)) return;

      // Cmd+←/→ (mac) / Ctrl+←/→ → 인접 뷰 전환(P3). alt/shift 동반 시는 무시(OS 단어 이동 등 보존).
      // editable 포커스·팔레트 오픈 시는 위 가드로 이미 비활성 → 캐럿 이동/팰레트 탐색 보존.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          clearPrefix();
          onAdjacentRef.current?.(e.key === "ArrowLeft" ? -1 : 1);
          return;
        }
      }

      // 그 외 modifier 동반은 chord/단일 단축키와 무관 → 비활성(타이핑·OS 단축키 보존).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const map = keymapRef.current;
      if (!map) return;

      const key = normalizeKey(e);
      if (!key) return;

      // 매칭 후보 = (prefix ? "prefix key" : "key").
      const combo = prefix ? `${prefix} ${key}` : key;

      // 1) 완성된 단축키와 정확히 일치?
      const exact = Object.entries(map).find(
        ([, sc]) => sc.trim() !== "" && sc.trim().toLowerCase() === combo,
      );
      if (exact) {
        e.preventDefault();
        clearPrefix();
        onJumpRef.current(exact[0] as View);
        return;
      }

      // 2) 이 키가 어떤 chord의 prefix(첫 토큰)인가? → prefix 보류.
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

      // 3) 아무 매칭 없음 → prefix 리셋(잘못된 chord).
      clearPrefix();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timer);
    };
  }, []);
}
