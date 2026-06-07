// 단축키 spec(modifier 조합) 공용 유틸 — 캡처 위젯과 런타임 매처가 같은 포맷을 쓰게 한다.
// 포맷: "Cmd+1" / "Ctrl+Shift+K" / "Cmd+," (mods 순서 Ctrl→Cmd→Alt→Shift + 키 라벨).
// 글로벌 창 핫키(shortcut.rs)와 동일 포맷 — per-view keymap도 이걸 재사용(modifier 없는 레거시
// 단일/체인 "g b"·"1"은 useViewShortcuts가 별도 경로로 계속 매칭).

const MOD_KEYS = ["Control", "Meta", "Alt", "Shift"];

const SPECIALS: Record<string, string> = {
  " ": "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  "\\": "Backslash",
  "/": "Slash",
  ".": "Period",
  ",": "Comma",
  ";": "Semicolon",
  "`": "Backquote",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/** keydown key → 화이트리스트 라벨(영숫자 대문자 / 특수키 / F1~F12). 미지원이면 null. */
function keyLabel(key: string): string | null {
  if (SPECIALS[key]) return SPECIALS[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase();
  return null;
}

type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * 키 이벤트 → "Cmd+1" 류 조합 spec. modifier가 하나도 없거나 modifier-only면 null
 * (조합 단축키만 — 단일 키/체인은 별도 레거시 경로). label 미지원도 null.
 */
export function eventToHotkeySpec(e: KeyEventLike): string | null {
  if (MOD_KEYS.includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.metaKey) mods.push("Cmd");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (mods.length === 0) return null;
  const label = keyLabel(e.key);
  if (!label) return null;
  return [...mods, label].join("+");
}

/** label → e.key 역매핑(SPECIALS 반대 방향). "Left"→"ArrowLeft", "Comma"→"," 등. */
const LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIALS).map(([key, label]) => [label, key]),
);

export interface ParsedHotkey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * "Cmd+Left" 류 spec → 합성 KeyboardEvent에 넣을 필드. modifier가 하나도 없거나
 * 키 라벨이 없으면 null(eventToHotkeySpec의 역). 단일 문자는 소문자 e.key로,
 * 특수 라벨은 LABEL_TO_KEY로 복원한다(F1~F12는 그대로).
 */
export function parseHotkeySpec(spec: string): ParsedHotkey | null {
  const parts = spec
    .trim()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const mods = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  let label: string | null = null;
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case "ctrl":
        mods.ctrlKey = true;
        break;
      case "cmd":
      case "meta":
        mods.metaKey = true;
        break;
      case "alt":
        mods.altKey = true;
        break;
      case "shift":
        mods.shiftKey = true;
        break;
      default:
        label = p;
    }
  }
  if (!label) return null;
  if (!mods.ctrlKey && !mods.metaKey && !mods.altKey && !mods.shiftKey) return null;
  const key = LABEL_TO_KEY[label] ?? (label.length === 1 ? label.toLowerCase() : label);
  return { key, ...mods };
}

/** spec 토큰 → 표시용 심볼. 매처/저장 포맷은 그대로 두고 표시(치트시트)만 변환. */
const DISPLAY_SYMBOLS: Record<string, string> = {
  Cmd: "⌘",
  Meta: "⌘",
  Ctrl: "⌃",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Backquote: "`",
  Space: "␣",
};

/**
 * "Cmd+Shift+K" → 표시용 "⌘⇧K"(순수). modifier는 심볼로, 그 외 라벨은 그대로 두고 구분자 없이 결합.
 * 매핑 없는 토큰은 원문 유지. 빈 spec은 빈 문자열.
 */
export function formatHotkeySpec(spec: string): string {
  return spec
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => DISPLAY_SYMBOLS[p] ?? p)
    .join("");
}
