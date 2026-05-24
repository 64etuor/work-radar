import { useState } from "react";

import type { Kind } from "@/bindings";
import { parseDump } from "@/components/board/board-utils";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Props = {
  /** kind = 파싱된 마커 우선, 없으면 토글 기본값. */
  onSubmit: (title: string, kind: Kind) => void;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

/** 하단 brain-dump 캡처 패널 (개인/업무 토글 + 입력 + 붙이기). */
export function CapturePanel({ onSubmit, disabled, inputRef }: Props) {
  const [value, setValue] = useState("");
  const [pendingKind, setPendingKind] = useState<Kind>("work");

  const submit = () => {
    const raw = value;
    if (!raw.trim()) return;
    const { kind, text } = parseDump(raw);
    if (!text) return;
    onSubmit(text, kind ?? pendingKind);
    setValue("");
  };

  return (
    <div className="capture">
      <span className="bd">Brain&nbsp;Dump</span>
      {/* 개인/업무 2-state 세그먼트(toggle-group). single이라 활성 항목 재클릭 시 빈값 콜백 → 가드로 무시(항상 1개 선택 보존). 의미색은 항목별 data-[state=on]:* (personal=accent-soft, work=pale-green). */}
      <ToggleGroup
        type="single"
        value={pendingKind}
        onValueChange={(v) => v && setPendingKind(v as Kind)}
        className="shrink-0 overflow-hidden rounded-full border border-wr-border-light"
      >
        <ToggleGroupItem
          value="personal"
          size="sm"
          className="font-semibold text-wr-subtle data-[state=on]:bg-wr-accent-soft data-[state=on]:text-wr-accent"
        >
          개인
        </ToggleGroupItem>
        <ToggleGroupItem
          value="work"
          size="sm"
          className="font-semibold text-wr-subtle data-[state=on]:bg-wr-pale-green data-[state=on]:text-wr-green"
        >
          업무
        </ToggleGroupItem>
      </ToggleGroup>
      {/* .dump = 보더리스/투명 blend-in 캡처 필드(16px·포커스 링 없음) — shadcn Input은 6+ 오버라이드+링 회귀라 bespoke 유지(plan §0.5 / AGENTS.md ≤3 규율). */}
      <input
        ref={inputRef}
        className="dump"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="예) '일, 데모 준비' · '개인, 원두 주문' — Enter로 톡"
        autoComplete="off"
        autoFocus
      />
      <Button type="button" size="pill" onClick={submit} disabled={disabled}>
        붙이기
      </Button>
    </div>
  );
}
