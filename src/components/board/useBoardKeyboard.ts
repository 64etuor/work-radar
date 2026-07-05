import { useEffect } from "react";

import { type ZoneKey } from "@/components/board/boardUtils";

const ZONE_KEY_MAP: Record<string, ZoneKey> = {
  "1": "q1",
  "2": "q2",
  "3": "q3",
  "4": "q4",
  "0": "unclassified",
  u: "unclassified",
};

/**
 * 보드 전역 키보드 (1/2/3/4 분류, 0/u 미분류, T Today, S 미루기, D/E 완료/보관) —
 * CaptureBoard에서 그대로 추출(ownership 가드의 hook-boundary 계약, 동작 불변).
 * Esc는 카드 메뉴만 닫고 셸 핸들러로 위임. 입력/contenteditable 포커스 중엔 무시.
 */
export function useBoardKeyboard({
  selectedId,
  onEscape,
  onClassify,
  onPromoteToday,
  onSnooze,
  onDone,
  onArchive,
}: {
  selectedId: string | null;
  onEscape: () => void;
  onClassify: (id: string, zone: ZoneKey) => void;
  onPromoteToday: (id: string) => void;
  onSnooze: (id: string) => void;
  onDone: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onEscape();
        return; // App 셸의 Esc 핸들러로 위임.
      }
      const ae = document.activeElement;
      if (
        ae instanceof HTMLInputElement ||
        ae instanceof HTMLTextAreaElement ||
        (ae instanceof HTMLElement && ae.isContentEditable)
      ) {
        return;
      }
      if (!selectedId) return;
      const z = ZONE_KEY_MAP[e.key];
      if (z) {
        onClassify(selectedId, z);
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "t") {
        onPromoteToday(selectedId);
        e.preventDefault();
      } else if (k === "s") {
        onSnooze(selectedId);
        e.preventDefault();
      } else if (k === "d") {
        onDone(selectedId);
        e.preventDefault();
      } else if (k === "e") {
        onArchive(selectedId);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, onEscape, onClassify, onPromoteToday, onSnooze, onDone, onArchive]);
}
