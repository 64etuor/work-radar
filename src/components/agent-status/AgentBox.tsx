import { useEffect, useRef, useState } from "react";

import { formatElapsedCompact, progressRatio } from "@/lib/agentBar";

import { BoxIcon } from "./BoxIcon";
import type { SessionBox } from "./shared";

/**
 * 박스 이름 인라인 입력. 마운트 시 포커스+전체선택, Enter/blur 저장, Esc 취소.
 * P2 `TitleEditor` 패턴 재사용: capture-phase Esc(App 셸 창 숨김 핸들러보다 먼저 가로챔)
 * + settled 1회 가드(Esc 언마운트→blur(commit) 되살아남 차단).
 */
function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => initial);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const commit = (value: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Esc 취소(캡처 단계 — App 셸의 창 숨김 핸들러보다 먼저 가로채야 한다).
  // synthetic stopPropagation은 native window 리스너를 못 막으므로 ProjectPickerModal과 동일 패턴.
  useEffect(() => {
    const cancelEdit = () => {
      if (settled.current) return;
      settled.current = true;
      onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        cancelEdit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <input
      ref={ref}
      className="asb-box-name-edit"
      aria-label="에이전트 박스 이름 편집"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(draft);
        }
      }}
    />
  );
}

/** 정체성 박스 1개 — 아이콘 + 이름 + 상태(색 dot + 라벨) + 경과 백필 wash. */
export function AgentBox({
  box,
  displayName,
  nowMs,
  editing,
  onOpen,
  onEditStart,
  onCommit,
  onCancel,
}: {
  box: SessionBox;
  /** 표시 이름 = app_config 오버라이드 또는 기본 라벨(box.name) fallback. */
  displayName: string;
  nowMs: number;
  editing: boolean;
  onOpen: () => void;
  onEditStart: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const working = box.state === "working";
  const elapsedSec = box.startedMs != null ? (nowMs - box.startedMs) / 1000 : 0;
  const ratio = working ? progressRatio(elapsedSec, box.timeoutSec) : 0;
  // 상태줄 = 라벨 + (working이면) 경과 병기 — "작업 중 · 12m".
  const stateLine =
    working && box.startedMs != null
      ? `${box.stateLabel} · ${formatElapsedCompact(elapsedSec)}`
      : box.stateLabel;

  // 편집 중에는 클릭이 Jobs로 이동하지 않도록 div로 전환(input 포커스 보존).
  const Tag = editing ? "div" : "button";

  return (
    <Tag
      type={editing ? undefined : "button"}
      className={`asb-box asb-box-${box.state}`}
      onClick={editing ? undefined : onOpen}
      title={editing ? undefined : box.title}
      aria-label={editing ? undefined : `${displayName} · ${stateLine}`}
    >
      {working && box.startedMs != null && !editing && (
        <span className="asb-box-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      )}
      {/* 상태 = 하단 보더 색 + 박스 내 마이크로 라벨 병기(색만으로 의미 전달 금지 — DESIGN.md). */}
      <span className="asb-box-icon">
        <BoxIcon box={box} size={13} />
      </span>
      {editing ? (
        <NameEditor initial={displayName} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span className="asb-box-text">
          <span
            className="asb-box-name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEditStart();
            }}
            title="더블클릭해서 이름 편집"
          >
            {displayName}
          </span>
          {/* 시각 상태 라벨 — 의미는 버튼 aria-label에 이미 병합, 중복 낭독 방지로 hidden. */}
          <span className="asb-box-state" aria-hidden="true">
            {stateLine}
          </span>
        </span>
      )}
    </Tag>
  );
}
