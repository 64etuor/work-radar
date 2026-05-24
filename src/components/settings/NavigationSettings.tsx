import { useEffect, useRef, useState } from "react";

import {
  useGlobalHotkey,
  useNavKeymap,
  useResetGlobalHotkey,
  useResetNavKeymap,
  useSetGlobalHotkey,
  useSetNavKeymap,
} from "@/lib/query";
import { NAV_ITEMS } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SectionLabel } from "./kit";

/**
 * 네비게이션 설정 (Phase 18 #7 + B2 Part C).
 * 글로벌 창 핫키: 키 캡처 위젯 — 버튼 클릭 후 실제 단축키 입력으로 기록.
 * per-view keymap: 각 뷰마다 키 캡처 위젯 (단일 키 또는 2-key chord).
 * 저장 포맷은 기존과 동일 ("Ctrl+Space", "g b", "1" 등) — 수기 타입 없음.
 */
export function NavigationSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const hotkey = useGlobalHotkey();
  const setHotkey = useSetGlobalHotkey();
  const resetHotkey = useResetGlobalHotkey();

  const keymap = useNavKeymap();
  const setKeymap = useSetNavKeymap();
  const resetKeymap = useResetNavKeymap();

  // 글로벌 핫키 — 캡처된 사람 읽을 수 있는 라벨 / 서버 저장 spec.
  const [hkSpec, setHkSpec] = useState("");
  const [hkRecording, setHkRecording] = useState(false);
  const [hkErr, setHkErr] = useState("");
  useEffect(() => {
    if (hotkey.data) setHkSpec(hotkey.data);
  }, [hotkey.data]);

  // keymap 드래프트 (view → shortcut spec string).
  const [kmDraft, setKmDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (keymap.data) setKmDraft(keymap.data);
  }, [keymap.data]);

  const saveHotkey = () => {
    const spec = hkSpec.trim();
    if (!spec || setHotkey.isPending) return;
    setHkErr("");
    setHotkey.mutate(spec, {
      onSuccess: () => onToast(`글로벌 핫키 변경됨: ${spec}`),
      onError: (e) => {
        setHkErr(String(e));
        onToast(String(e));
      },
    });
  };

  const resetHk = () => {
    if (resetHotkey.isPending) return;
    setHkErr("");
    resetHotkey.mutate(undefined, {
      onSuccess: (def) => {
        setHkSpec(def);
        onToast(`글로벌 핫키 기본값으로: ${def}`);
      },
      onError: (e) => onToast(String(e)),
    });
  };

  const saveKeymap = () => {
    if (setKeymap.isPending) return;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(kmDraft)) cleaned[k] = v.trim();
    setKeymap.mutate(cleaned, {
      onSuccess: () => onToast("메뉴 단축키 저장됨"),
      onError: (e) => onToast(String(e)),
    });
  };

  const resetKm = () => {
    if (resetKeymap.isPending) return;
    resetKeymap.mutate(undefined, {
      onSuccess: () => onToast("메뉴 단축키 기본값으로 리셋됨"),
      onError: (e) => onToast(String(e)),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">네비게이션 / 단축키</span>
      </div>

      {/* 글로벌 창 핫키 — 키 캡처 */}
      <div className="flex items-center gap-2">
        <span className="min-w-[96px] text-xs text-muted-foreground">글로벌 창 핫키</span>
        <GlobalHotkeyCapture
          value={hkSpec}
          onChange={setHkSpec}
          recording={hkRecording}
          setRecording={setHkRecording}
        />
        <Button
          size="sm"
          onClick={saveHotkey}
          disabled={setHotkey.isPending || hkSpec.trim() === hotkey.data}
          title="창 토글 핫키를 변경하고 즉시 재등록"
        >
          {setHotkey.isPending ? "등록 중…" : "변경"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetHk}
          disabled={resetHotkey.isPending}
          title="기본값 Ctrl+Space로 리셋"
        >
          기본값
        </Button>
      </div>
      {hkErr && (
        <p className="text-xs text-[color:var(--destructive)]">{hkErr}</p>
      )}
      <p className="text-xs text-muted-foreground">
        캡처 버튼 클릭 후 원하는 단축키를 누르세요 (예: Ctrl+Space, Cmd+Shift+K).
        변경 시 즉시 재등록되며, 충돌 또는 지원하지 않는 키이면 이전 핫키를 유지합니다.
      </p>

      {/* per-view keymap */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>메뉴별 단축키 (입력 중이 아닐 때 적용)</SectionLabel>
        <div className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <div key={item.view} className="flex items-center gap-3 py-1">
              <span className="w-28 shrink-0 text-[13px] text-foreground">{item.label}</span>
              <ViewKeymapCapture
                value={kmDraft[item.view] ?? ""}
                onChange={(v) =>
                  setKmDraft((prev) => ({ ...prev, [item.view]: v }))
                }
                label={item.label}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={saveKeymap}
          disabled={setKeymap.isPending}
        >
          {setKeymap.isPending ? "저장 중…" : "단축키 저장"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetKm}
          disabled={resetKeymap.isPending}
        >
          기본값으로 리셋
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        캡처 버튼 클릭 후 단일 키(1) 또는 시퀀스(g → b = "g b")를 입력하세요.
        빈 칸은 그 뷰의 단축키를 끕니다. 입력란에 포커스가 있을 땐 적용되지 않습니다.
      </p>

      {hotkey.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(hotkey.error)}</p>
      )}
    </div>
  );
}

// ── 글로벌 핫키 캡처 위젯 ────────────────────────────────────────────────

/**
 * 모디파이어+키 조합을 캡처하는 위젯.
 * 허용 modifier: Ctrl/Alt/Shift/Cmd(Meta). 조합이 완성되면 "Ctrl+Space" 형식으로 onChange 호출.
 */
function GlobalHotkeyCapture({
  value,
  onChange,
  recording,
  setRecording,
}: {
  value: string;
  onChange: (spec: string) => void;
  recording: boolean;
  setRecording: (r: boolean) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.metaKey) mods.push("Cmd");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");

    // modifier-only keydown은 무시 — 실제 키 기다림.
    const mod_keys = ["Control", "Meta", "Alt", "Shift"];
    if (mod_keys.includes(e.key)) return;

    if (mods.length === 0) {
      // modifier 없이 Escape면 캡처 취소.
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      // modifier 없는 단일 키는 글로벌 핫키로 허용하지 않음.
      return;
    }

    const keyLabel = keyEventToLabel(e);
    if (!keyLabel) return;

    const spec = [...mods, keyLabel].join("+");
    onChange(spec);
    setRecording(false);
  };

  const start = () => {
    setRecording(true);
    btnRef.current?.focus();
  };

  return (
    <div className="flex-1">
      <button
        ref={btnRef}
        type="button"
        className={cn(
          "flex h-9 w-full items-center rounded-md border border-input bg-background px-3 text-sm font-mono text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          recording && "border-primary ring-2 ring-ring",
        )}
        onClick={start}
        onKeyDown={handleKeyDown}
        onBlur={() => setRecording(false)}
        aria-label="글로벌 핫키 캡처"
        title={recording ? "단축키를 누르세요 (Esc = 취소)" : "클릭 후 단축키 입력"}
      >
        {recording ? "🔴 단축키를 누르세요…" : value || "캡처하려면 클릭"}
      </button>
    </div>
  );
}

// ── 뷰 단축키 캡처 위젯 (단일 키 또는 2-key chord) ──────────────────────

type ChordState = { step: "idle" } | { step: "first"; key: string };

/**
 * 단일 키(예: "1") 또는 2-key chord(예: "g b")를 캡처하는 위젯.
 * 첫 키 입력 후 200ms 내에 두 번째 키가 없으면 단일 키로 확정.
 * "g" 같은 prefix 키 입력 후 두 번째 키를 기다려 chord 완성.
 */
function ViewKeymapCapture({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [recording, setRecording] = useState(false);
  const [chord, setChord] = useState<ChordState>({ step: "idle" });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const commit = (spec: string) => {
    clearTimer();
    onChange(spec);
    setChord({ step: "idle" });
    setRecording(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      clearTimer();
      setChord({ step: "idle" });
      setRecording(false);
      return;
    }
    // Ignore bare modifiers.
    if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;

    const key = e.key.toLowerCase();

    if (chord.step === "idle") {
      // Wait 400ms for a second key (chord). If none arrives, commit single.
      setChord({ step: "first", key });
      clearTimer();
      timerRef.current = setTimeout(() => {
        // No second key — commit as single.
        commit(key);
      }, 400);
    } else {
      // Second key arrived — commit as chord.
      const spec = `${chord.key} ${key}`;
      commit(spec);
    }
  };

  const start = () => {
    setRecording(true);
    setChord({ step: "idle" });
    clearTimer();
    btnRef.current?.focus();
  };

  const chordHint =
    chord.step === "first" ? `${chord.key} + …` : undefined;

  const displayLabel = recording
    ? chordHint ?? "키를 누르세요…"
    : value || "캡처하려면 클릭";

  return (
    <button
      ref={btnRef}
      type="button"
      className={cn(
        "flex h-8 min-w-[100px] items-center rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        recording && "border-primary ring-2 ring-ring",
      )}
      onClick={start}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        // Blur: commit what we have (single key if waiting), or cancel.
        if (chord.step === "first") {
          commit(chord.key);
        } else {
          clearTimer();
          setRecording(false);
        }
      }}
      aria-label={`${label} 단축키 캡처`}
      title={recording ? "단축키를 누르세요 (Esc = 취소)" : "클릭 후 단축키 입력"}
    >
      {recording ? `🔴 ${displayLabel}` : value || "—"}
    </button>
  );
}

/** keydown event → whitelist 키 이름 (shortcut.rs 화이트리스트와 맞춤). */
function keyEventToLabel(e: React.KeyboardEvent): string | null {
  const key = e.key;
  // Special keys.
  const specials: Record<string, string> = {
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
    F1: "F1",
    F2: "F2",
    F3: "F3",
    F4: "F4",
    F5: "F5",
    F6: "F6",
    F7: "F7",
    F8: "F8",
    F9: "F9",
    F10: "F10",
    F11: "F11",
    F12: "F12",
  };
  if (specials[key]) return specials[key];
  // Single alphanumeric.
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase();
  return null;
}
