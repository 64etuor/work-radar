import { useEffect, useMemo, useRef, useState } from "react";

import {
  useGlobalHotkey,
  useNavKeymap,
  useResetGlobalHotkey,
  useResetNavKeymap,
  useSetGlobalHotkey,
  useSetNavKeymap,
} from "@/lib/query";
import { EXTRA_ACTIONS, NAV_ITEMS } from "@/lib/nav";
import { eventToHotkeySpec } from "@/lib/hotkey";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SectionLabel } from "./kit";

/** 키맵 에디터 행: view + EXTRA_ACTIONS(calendar 등)를 한 목록으로. */
const KEYMAP_ROWS: { key: string; label: string }[] = [
  ...NAV_ITEMS.map((n) => ({ key: n.view as string, label: n.label })),
  ...EXTRA_ACTIONS.map((a) => ({ key: a.key, label: a.label })),
];

/**
 * 네비게이션 설정 (Phase 18 #7 + B2 Part C).
 * 글로벌 창 핫키: 키 캡처 위젯 — 버튼 클릭 후 실제 단축키 입력으로 기록.
 * per-action keymap: 각 메뉴/액션마다 조합 단축키 캡처(Cmd+숫자 등). 빈 값 = 끔.
 * 중복 단축키는 빨갛게 경고만 — 저장은 허용(사용자 정책). 저장 포맷은 spec 문자열.
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

  // keymap 드래프트 (action → shortcut spec string).
  const [kmDraft, setKmDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (keymap.data) setKmDraft(keymap.data);
  }, [keymap.data]);

  // 중복 감지: 같은 spec(대소문자 무시)을 2개 이상 액션이 쓰면 그 행을 빨갛게(경고만).
  const specCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const v of Object.values(kmDraft)) {
      const s = v.trim().toLowerCase();
      if (s) c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [kmDraft]);
  const isDup = (spec: string) => {
    const s = spec.trim().toLowerCase();
    return s !== "" && (specCounts[s] ?? 0) > 1;
  };
  const hasDup = Object.values(specCounts).some((n) => n > 1);

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
    // 중복이 있어도 저장은 허용(사용자 정책) — 경고만 띄운다.
    setKeymap.mutate(cleaned, {
      onSuccess: () =>
        onToast(hasDup ? "단축키 저장됨 (중복 있음 — 경고 확인)" : "메뉴 단축키 저장됨"),
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

      {/* per-action keymap */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>메뉴 단축키 (기본 Cmd+숫자 · 빈 값 = 끔)</SectionLabel>
        <div className="flex flex-col gap-1">
          {KEYMAP_ROWS.map((row) => (
            <div key={row.key} className="flex items-center gap-3 py-1">
              <span className="w-28 shrink-0 text-[13px] text-foreground">{row.label}</span>
              <ViewKeymapCapture
                value={kmDraft[row.key] ?? ""}
                onChange={(v) =>
                  setKmDraft((prev) => ({ ...prev, [row.key]: v }))
                }
                label={row.label}
                duplicate={isDup(kmDraft[row.key] ?? "")}
              />
            </div>
          ))}
        </div>
      </div>

      {hasDup && (
        <p className="text-xs text-[color:var(--destructive)]">
          ⚠ 중복된 단축키가 있습니다(빨강 표시). 저장은 되지만 같은 키에 여러 메뉴가 묶이면
          마지막으로 매칭된 항목만 동작할 수 있습니다.
        </p>
      )}

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
        캡처 버튼 클릭 후 조합 단축키(예: Cmd+1, Cmd+Shift+C)를 누르세요. ✕로 끄기.
        조합 단축키는 입력 중에도 동작합니다.
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
    // modifier 없이 Escape면 캡처 취소.
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setRecording(false);
      return;
    }
    const spec = eventToHotkeySpec(e);
    // modifier-only/단일키/미지원 → 계속 대기. 글로벌 핫키는 modifier 필수.
    if (!spec) return;
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

// ── 메뉴 단축키 캡처 위젯 (조합 단축키 — Cmd+숫자 등) ────────────────────

/**
 * 조합 단축키(예: "Cmd+1", "Cmd+Shift+C")를 캡처한다. modifier 필수 — 단일/체인은 받지 않는다
 * (레거시 저장값은 런타임 매처가 계속 인식하지만, 신규 캡처는 조합만). ✕로 끄기, Esc로 취소.
 * duplicate=true면 다른 액션과 같은 단축키 → 빨갛게(경고만).
 */
function ViewKeymapCapture({
  value,
  onChange,
  label,
  duplicate,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  duplicate: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setRecording(false);
      return;
    }
    const spec = eventToHotkeySpec(e);
    if (!spec) return; // modifier-only/단일키 → 계속 대기(조합 필수).
    onChange(spec);
    setRecording(false);
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        ref={btnRef}
        type="button"
        className={cn(
          "flex h-8 min-w-[120px] items-center rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          recording && "border-primary ring-2 ring-ring",
          duplicate &&
            !recording &&
            "border-[color:var(--destructive)] text-[color:var(--destructive)]",
        )}
        onClick={() => {
          setRecording(true);
          btnRef.current?.focus();
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setRecording(false)}
        aria-label={`${label} 단축키 캡처`}
        title={
          recording
            ? "조합 단축키를 누르세요 (Esc = 취소)"
            : "클릭 후 조합 단축키 입력 (예: Cmd+1)"
        }
      >
        {recording ? "🔴 단축키를 누르세요…" : value || "—"}
      </button>
      {value && !recording && (
        <button
          type="button"
          className="px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onChange("")}
          aria-label={`${label} 단축키 끄기`}
          title="단축키 끄기"
        >
          ✕
        </button>
      )}
    </div>
  );
}
