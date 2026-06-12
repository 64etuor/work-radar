import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useRef, useState } from "react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { knobActionFor, knobActionOptions, knobTokenForAction } from "@/lib/appActions";
import { eventToHotkeySpec } from "@/lib/hotkey";
import {
  EXTRA_ACTIONS,
  isKnobKeymapKey,
  KNOB_DIRECTIONS,
  KNOB_TRIGGER_KEY,
  NAV_ITEMS,
} from "@/lib/nav";
import {
  useGlobalHotkey,
  useNavKeymap,
  useResetGlobalHotkey,
  useResetNavKeymap,
  useSetGlobalHotkey,
  useSetNavKeymap,
} from "@/lib/query";
import { unwrap } from "@/lib/query/client";

import { HotkeyCapture } from "./HotkeyCapture";
import { SectionLabel } from "./SettingsKit";

type GlobalHotkeyQuery = ReturnType<typeof useGlobalHotkey>;
type SetGlobalHotkeyMutation = ReturnType<typeof useSetGlobalHotkey>;
type ResetGlobalHotkeyMutation = ReturnType<typeof useResetGlobalHotkey>;
type NavKeymapMutation = ReturnType<typeof useSetNavKeymap>;
type ResetNavKeymapMutation = ReturnType<typeof useResetNavKeymap>;

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
export function NavigationSettings({ onToast }: { onToast: (msg: string) => void }) {
  const hotkey = useGlobalHotkey();
  const setHotkey = useSetGlobalHotkey();
  const resetHotkey = useResetGlobalHotkey();

  const keymap = useNavKeymap();
  const setKeymap = useSetNavKeymap();
  const resetKeymap = useResetNavKeymap();

  // Hermes 패널 토글 — OS 글로벌 단축키 (hermesGetToggleHotkey / hermesSetToggleHotkey).
  const qc = useQueryClient();
  const { data: hermesHotkeyData } = useQuery({
    queryKey: ["hermes-toggle-hotkey"],
    queryFn: async () => unwrap(commands.hermesGetToggleHotkey()),
  });
  const setHermesHotkey = useMutation({
    mutationFn: async (spec: string) => unwrap(commands.hermesSetToggleHotkey(spec)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hermes-toggle-hotkey"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">네비게이션 / 단축키</span>
      </div>

      {/* 글로벌 창 핫키 — 키 캡처 */}
      <GlobalHotkeyEditor
        key={hotkey.data ?? ""}
        hotkey={hotkey}
        setHotkey={setHotkey}
        resetHotkey={resetHotkey}
        onToast={onToast}
      />
      <p className="text-muted-foreground text-xs">
        캡처 버튼 클릭 후 원하는 단축키를 누르세요 (예: Ctrl+Space, Cmd+Shift+K). 변경 시 즉시
        재등록되며, 충돌 또는 지원하지 않는 키이면 이전 핫키를 유지합니다.
      </p>

      {/* Hermes 패널 토글 — OS 글로벌 단축키 */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground min-w-[96px] text-xs">Hermes 패널 토글</span>
        <HotkeyCapture
          value={hermesHotkeyData ?? "Cmd+Shift+Space"}
          onChange={(spec) => setHermesHotkey.mutate(spec)}
        />
      </div>
      {setHermesHotkey.isError && (
        <p className="text-xs text-[color:var(--destructive)]">
          단축키 등록 실패 — 다른 앱이나 nav 단축키와 충돌일 수 있습니다.
        </p>
      )}

      {/* per-action keymap */}
      <KeymapEditor
        key={JSON.stringify(keymap.data ?? {})}
        initialDraft={keymap.data ?? {}}
        setKeymap={setKeymap}
        resetKeymap={resetKeymap}
        onToast={onToast}
      />

      {hotkey.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(hotkey.error)}</p>
      )}
    </div>
  );
}

function GlobalHotkeyEditor({
  hotkey,
  setHotkey,
  resetHotkey,
  onToast,
}: {
  hotkey: GlobalHotkeyQuery;
  setHotkey: SetGlobalHotkeyMutation;
  resetHotkey: ResetGlobalHotkeyMutation;
  onToast: (msg: string) => void;
}) {
  // 글로벌 핫키 — 캡처된 사람 읽을 수 있는 라벨 / 서버 저장 spec.
  const [hkSpec, setHkSpec] = useState(() => hotkey.data ?? "");
  const [hkErr, setHkErr] = useState("");

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

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground min-w-[96px] text-xs">글로벌 창 핫키</span>
        <HotkeyCapture value={hkSpec} onChange={setHkSpec} />
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
      {hkErr && <p className="text-xs text-[color:var(--destructive)]">{hkErr}</p>}
    </>
  );
}

function KeymapEditor({
  initialDraft,
  setKeymap,
  resetKeymap,
  onToast,
}: {
  initialDraft: Record<string, string>;
  setKeymap: NavKeymapMutation;
  resetKeymap: ResetNavKeymapMutation;
  onToast: (msg: string) => void;
}) {
  // keymap 드래프트 (action → shortcut spec string).
  const [kmDraft, setKmDraft] = useState(() => initialDraft);

  // 중복 감지: 같은 spec(대소문자 무시)을 2개 이상 액션이 쓰면 그 행을 빨갛게(경고만).
  // knob 예약 키는 제외 — 값이 단축키 spec이 아니라 액션 토큰이라 중복 개념이 다르다.
  const specCounts = (() => {
    const c: Record<string, number> = {};
    for (const [k, v] of Object.entries(kmDraft)) {
      if (isKnobKeymapKey(k)) continue;
      const s = v.trim().toLowerCase();
      if (s) c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  })();
  const isDup = (spec: string) => {
    const s = spec.trim().toLowerCase();
    return s !== "" && (specCounts[s] ?? 0) > 1;
  };
  const hasDup = Object.values(specCounts).some((n) => n > 1);

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
    <>
      <div className="flex flex-col gap-1.5">
        <SectionLabel>메뉴 단축키 (기본 Cmd+숫자 · 빈 값 = 끔)</SectionLabel>
        <div className="flex flex-col gap-1">
          {KEYMAP_ROWS.map((row) => (
            <div key={row.key} className="flex items-center gap-3 py-1">
              <span className="text-foreground typo-body-md w-28 shrink-0">{row.label}</span>
              <ViewKeymapCapture
                value={kmDraft[row.key] ?? ""}
                onChange={(v) => setKmDraft((prev) => ({ ...prev, [row.key]: v }))}
                label={row.label}
                duplicate={isDup(kmDraft[row.key] ?? "")}
              />
            </div>
          ))}
        </div>
      </div>

      {hasDup && (
        <p className="flex items-start gap-1.5 text-xs text-[color:var(--destructive)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            중복된 단축키가 있습니다(빨강 표시). 저장은 되지만 같은 키에 여러 메뉴가 묶이면
            마지막으로 매칭된 항목만 동작할 수 있습니다.
          </span>
        </p>
      )}

      {/* 조이스틱(knob) — 방향별 발사 단축키 + 호출 키 */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>조이스틱 (호출 키 hold → 커서에 등장, 방향으로 밀어 실행)</SectionLabel>
        <div className="flex items-center gap-3 py-1">
          <span className="text-foreground typo-body-md w-28 shrink-0">호출 키</span>
          <TriggerPicker
            value={kmDraft[KNOB_TRIGGER_KEY] ?? ""}
            onChange={(v) => setKmDraft((prev) => ({ ...prev, [KNOB_TRIGGER_KEY]: v }))}
          />
        </div>
        {KNOB_DIRECTIONS.map((d) => (
          <div key={d.key} className="flex items-center gap-3 py-1">
            <span className="text-foreground typo-body-md w-28 shrink-0">{d.label}</span>
            <KnobActionSelect
              value={kmDraft[d.key] ?? ""}
              keymap={kmDraft}
              onChange={(v) => setKmDraft((prev) => ({ ...prev, [d.key]: v }))}
              label={d.label}
            />
          </div>
        ))}
        <p className="text-muted-foreground text-xs">
          방향마다 실행할 액션을 고르세요(이전/다음 뷰, 특정 뷰 열기, 캘린더·Inbox 토글). 없음 = 그
          방향 비활성.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={saveKeymap} disabled={setKeymap.isPending}>
          {setKeymap.isPending ? "저장 중…" : "단축키 저장"}
        </Button>
        <Button variant="ghost" size="sm" onClick={resetKm} disabled={resetKeymap.isPending}>
          기본값으로 리셋
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        캡처 버튼 클릭 후 조합 단축키(예: Cmd+1, Cmd+Shift+C)를 누르세요. ✕로 끄기. 조합 단축키는
        입력 중에도 동작합니다.
      </p>
    </>
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
          "border-input bg-background text-foreground focus-visible:ring-ring flex h-8 min-w-[120px] items-center rounded-md border px-3 font-mono text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
          recording && "border-primary ring-ring ring-2",
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
          recording ? "조합 단축키를 누르세요 (Esc = 취소)" : "클릭 후 조합 단축키 입력 (예: Cmd+1)"
        }
      >
        {recording ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-[color:var(--destructive)]"
            />
            단축키를 누르세요…
          </span>
        ) : (
          value || "—"
        )}
      </button>
      {value && !recording && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground px-1 text-xs transition-colors"
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

// ── 조이스틱 방향 액션 드롭다운 ───────────────────────────────────

/** Radix Select는 빈 문자열 value를 허용하지 않아 "없음"은 sentinel로 표현. */
const KNOB_OFF = "__off__";

/**
 * knob 방향 값(액션 토큰 정본 / 레거시 콤보 호환)을 액션 드롭다운으로 편집한다(ADR-0011 후속 ①).
 * 표시 값은 항상 동등 토큰으로 정규화(knobActionFor→knobTokenForAction) — 레거시 콤보
 * ("Cmd+Left")도 해당 액션으로 보이고, 변경 시 토큰으로 저장돼 자연 이행된다.
 */
function KnobActionSelect({
  value,
  keymap,
  onChange,
  label,
}: {
  value: string;
  keymap: Record<string, string>;
  onChange: (v: string) => void;
  label: string;
}) {
  const action = knobActionFor(value, keymap);
  const token = action ? knobTokenForAction(action) : KNOB_OFF;
  return (
    <Select value={token} onValueChange={(v) => onChange(v === KNOB_OFF ? "" : v)}>
      <SelectTrigger className="h-8 w-auto min-w-[160px]" aria-label={`${label} 액션 선택`}>
        <SelectValue placeholder="없음" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={KNOB_OFF}>없음</SelectItem>
        {knobActionOptions().map((o) => (
          <SelectItem key={o.token} value={o.token}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── 호출 키(모디파이어 전용) 칩 피커 ───────────────────────────────
const TRIGGER_CHIPS: { mod: string; glyph: string }[] = [
  { mod: "Cmd", glyph: "⌘" },
  { mod: "Ctrl", glyph: "⌃" },
  { mod: "Alt", glyph: "⌥" },
  { mod: "Shift", glyph: "⇧" },
];

/** "Cmd+Shift" 류 spec ↔ 칩 토글. 모디파이어 순서는 Ctrl→Cmd→Alt→Shift 고정. */
function TriggerPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const active = new Set(
    value.split("+").flatMap((p) => {
      const t = p.trim();
      return t ? [t] : [];
    }),
  );
  const toggle = (mod: string) => {
    const next = new Set(active);
    if (next.has(mod)) next.delete(mod);
    else next.add(mod);
    const ordered = ["Ctrl", "Cmd", "Alt", "Shift"].filter((m) => next.has(m));
    onChange(ordered.join("+"));
  };
  return (
    <div className="flex items-center gap-1.5">
      {TRIGGER_CHIPS.map((c) => (
        <button
          key={c.mod}
          type="button"
          className={cn(
            "border-input bg-background text-foreground flex h-8 min-w-[40px] items-center justify-center rounded-md border font-mono text-sm transition-colors",
            active.has(c.mod) && "border-primary ring-ring ring-2",
          )}
          onClick={() => toggle(c.mod)}
          aria-pressed={active.has(c.mod)}
          title={`${c.mod} 토글`}
        >
          {c.glyph}
        </button>
      ))}
    </div>
  );
}
