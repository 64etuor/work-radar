import "./CmdShortcutBar.css";

import { formatHotkeySpec } from "@/lib/hotkey";
import { buildShortcutHints } from "@/lib/nav";
import { useNavKeymap } from "@/lib/query";

/**
 * Cmd-hold 세션에서 화면 하단에 고정되는 단축키 치트시트(설계 2026-06-07).
 * 설정 키맵에서 설정된 nav/액션 단축키만(`buildShortcutHints`) 표시 — 정렬 로직 없이 하단 중앙 고정.
 * CmdKnob의 visible에 종속(레버/메뉴와 같은 세션). 설정된 단축키가 없으면 렌더하지 않는다.
 */
export function CmdShortcutBar() {
  const keymap = useNavKeymap();
  const hints = buildShortcutHints(keymap.data);
  if (hints.length === 0) return null;

  return (
    <div className="cmd-shortcut-bar" role="presentation" aria-hidden>
      {hints.map((h) => (
        <span key={h.key} className="cmd-shortcut-hint">
          <span className="cmd-shortcut-label">{h.label}</span>
          <kbd className="cmd-shortcut-kbd">{formatHotkeySpec(h.spec)}</kbd>
        </span>
      ))}
    </div>
  );
}
