import { useState } from "react";

import type { Kind } from "@/bindings";
import { parseDump } from "@/components/board/board-utils";

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
      <div className="seg">
        <button
          type="button"
          data-kind="personal"
          className={pendingKind === "personal" ? "on" : ""}
          onClick={() => setPendingKind("personal")}
        >
          개인
        </button>
        <button
          type="button"
          data-kind="work"
          className={pendingKind === "work" ? "on" : ""}
          onClick={() => setPendingKind("work")}
        >
          업무
        </button>
      </div>
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
      <button type="button" className="send" onClick={submit} disabled={disabled}>
        붙이기
      </button>
    </div>
  );
}
