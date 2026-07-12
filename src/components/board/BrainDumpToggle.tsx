import "./BrainDumpToggle.css";

import { CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Kind } from "@/bindings";
import { parseDump } from "@/components/board/boardUtils";
import { nextBrainDumpKind } from "@/components/board/brainDumpKind";
import { shouldOpenBrainDumpFromGlobalEnter } from "@/components/board/BrainDumpToggleEvents";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isComposingEnter } from "@/lib/ime";

type Props = {
  /** kind = 파싱된 마커 우선, 없으면 토글 기본값. */
  onSubmit: (title: string, kind: Kind) => void;
  disabled?: boolean;
  /** CaptureBoard가 단축키(F)로 포커스를 요청할 때 사용. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

/**
 * 매트릭스 사분면 정중앙(교차점)에 떠 있는 BrainDump 토글.
 * collapsed: 원형 트리거(48px, `CornerDownLeft` ⏎ + 펄스 링).
 * expanded: 가로 pill로 확장(원형 트리거가 왼쪽 안으로 흡수되며 form fade-in).
 *
 * 활성화 경로 3가지(collapsed → expanded 동일 결과):
 * 1) 트리거 클릭
 * 2) 트리거 포커스 + Enter
 * 3) **전역 Enter** — 입력/contenteditable에 포커스 없을 때 어디서든
 *
 * Esc(빈 입력) / 외부 클릭(빈 입력) / submit 후 → collapsed로 복귀.
 * 입력에 텍스트 있을 때 Esc는 collapse 안 함(사용자 데이터 보호).
 *
 * **App 셸과의 계약**: open 동안 `data-wr-overlay-open` 마커(overlay-stack 단일 진실원) → App `window.hide()` 양보.
 * Esc는 `preventDefault + stopPropagation`으로 셸 핸들러 도달 차단.
 * close 시 트리거 버튼으로 포커스 복원(radix Dialog와 동등 동작) — 키보드 흐름 유지.
 *
 * **애니메이션**: width grow + form fade-in (250ms cubic-bezier). `prefers-reduced-motion: reduce`면
 * transition/펄스 모두 무효(시각 동치, 동작 동등).
 */
export function BrainDumpToggle({ onSubmit, disabled, inputRef }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [pendingKind, setPendingKind] = useState<Kind>("work");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const innerInputRef = useRef<HTMLInputElement>(null);
  // 외부에서 inputRef를 받으면 그것을 사용(단축키 포커스), 없으면 내부 ref.
  const effectiveInputRef = inputRef ?? innerInputRef;
  // close 직후 트리거로 포커스 복원해야 하는지 추적.
  const wasOpenRef = useRef(false);

  // expanded 시 input 자동 포커스, collapse 후 트리거로 포커스 복원.
  useEffect(() => {
    if (open) {
      effectiveInputRef.current?.focus();
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open, effectiveInputRef]);

  // 외부 클릭 collapse(빈 입력일 때만). bubble phase — 다른 핸들러 stopPropagation 존중.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      if (value.trim().length === 0) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, value]);

  // 전역 Enter — collapsed && 다른 overlay/interactive control이 이벤트를 소유하지 않을 때만.
  useEffect(() => {
    if (open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!shouldOpenBrainDumpFromGlobalEnter(e, document.activeElement)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const submit = () => {
    const raw = value;
    if (!raw.trim()) return;
    const { kind, text } = parseDump(raw);
    if (!text) return;
    onSubmit(text, kind ?? pendingKind);
    setValue("");
    setOpen(false);
  };

  const togglePendingKind = () => {
    setPendingKind((kind) => nextBrainDumpKind(kind));
    window.requestAnimationFrame(() => effectiveInputRef.current?.focus());
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposingEnter(e)) return; // 한글 조합 확정 Enter는 제출 아님
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Tab") {
      onFormControlKeyDown(e);
    } else if (e.key === "Escape") {
      if (value.trim().length === 0) {
        // App 셸까지 안 가도록 즉시 차단(없으면 window가 hide됨 — INVARIANT 회귀).
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  const onFormControlKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    togglePendingKind();
  };

  return (
    <div
      ref={rootRef}
      className="brain-dump-toggle"
      data-state={open ? "open" : "closed"}
      // overlay-stack 단일 진실원: open일 때만 마커 → App 셸 Esc가 창 숨김 양보 + knob 억제.
      data-wr-overlay-open={open ? "" : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="bd-trigger"
        onClick={() => setOpen(true)}
        aria-label={open ? "브레인 덤프 입력" : "브레인 덤프 열기 (Enter)"}
        aria-expanded={open}
        title="브레인 덤프 (Enter)"
        // 펼친 상태에선 폼 안 elements가 우선 — 트리거는 포커스 순환에서 제외.
        tabIndex={open ? -1 : 0}
      >
        <CornerDownLeft aria-hidden className="bd-icon" size={16} />
        {/* 미래적 펄스 링 — collapsed일 때만 발산(CSS에서 data-state로 토글). */}
        <span className="bd-pulse" aria-hidden />
      </button>

      {/* 폼은 항상 마운트되어 transition 안정. closed면 aria-hidden + tabindex −1로 비활성. */}
      <form
        className="bd-form"
        aria-hidden={!open}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="bd-label" aria-hidden>
          BRAIN
        </span>
        <ToggleGroup
          type="single"
          value={pendingKind}
          onValueChange={(v) => v && setPendingKind(v as Kind)}
          className="border-wr-border-light shrink-0 overflow-hidden rounded-full border"
        >
          <ToggleGroupItem
            value="personal"
            size="sm"
            tabIndex={open ? 0 : -1}
            onKeyDown={onFormControlKeyDown}
            className="text-wr-subtle data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground font-semibold"
          >
            개인
          </ToggleGroupItem>
          <ToggleGroupItem
            value="work"
            size="sm"
            tabIndex={open ? 0 : -1}
            onKeyDown={onFormControlKeyDown}
            className="text-wr-subtle data-[state=on]:bg-accent data-[state=on]:text-accent-foreground font-semibold"
          >
            업무
          </ToggleGroupItem>
        </ToggleGroup>
        {/* .dump = 보더리스 캡처 필드(shadcn Input은 6+ 오버라이드+링 회귀라 bespoke 유지, AGENTS.md ≤3 규율). */}
        <input
          ref={effectiveInputRef}
          className="dump"
          type="text"
          aria-label="할 일 입력"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="예) '일, 데모 준비' · '개인, 원두 주문'"
          autoComplete="off"
          tabIndex={open ? 0 : -1}
        />
        <Button
          type="submit"
          size="pill"
          disabled={disabled}
          tabIndex={open ? 0 : -1}
          onKeyDown={onFormControlKeyDown}
        >
          붙이기
        </Button>
      </form>
    </div>
  );
}
