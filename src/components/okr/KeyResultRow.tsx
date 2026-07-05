import { ListChecks } from "lucide-react";
import { useState } from "react";

import type { KeyResult, OkrCheckIn, OkrMilestone } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { keyResultProgressRatio } from "@/lib/okr";
import { useDeleteKeyResult, useUpdateKeyResult } from "@/lib/query";

import { ArmedDeleteButton } from "./ArmedDeleteButton";
import { DraftInput } from "./DraftInput";
import { CONFIDENCE_LABELS, parseNullableNumber } from "./okrControls";

/**
 * KR 인라인 편집 행 — 모든 필드는 blur/Enter 자동 커밋(DraftInput). 별도 저장 버튼 없음.
 * 리마운트 key 불필요: 편집 중(focused) 필드만 로컬 draft라 refetch가 덮지 않는다.
 */
export function KeyResultRow({
  kr,
  latestCheckIn,
  readOnly,
}: {
  kr: KeyResult;
  latestCheckIn: OkrCheckIn | null;
  readOnly: boolean;
}) {
  const updateKeyResult = useUpdateKeyResult();
  const deleteKeyResult = useDeleteKeyResult();
  const progress = keyResultProgressRatio(kr);
  const pending = updateKeyResult.isPending || deleteKeyResult.isPending;

  // 부분 patch — 현재 서버값 위에 바뀐 필드만 합성해 기존 전체-업데이트 커맨드에 태운다.
  const patch = (partial: Partial<Parameters<typeof updateKeyResult.mutateAsync>[0]>) =>
    void updateKeyResult.mutateAsync({
      id: kr.id,
      title: kr.title,
      kind: kr.kind,
      currentValue: kr.currentValue,
      targetValue: kr.targetValue,
      unit: kr.unit,
      milestones: kr.milestones,
      sortRank: kr.sortRank,
      ...partial,
    });

  return (
    <div className="mission-kr-row">
      <div className="mission-kr-main">
        <DraftInput
          className="mission-kr-title"
          value={kr.title}
          disabled={readOnly}
          onCommit={(next) => {
            const clean = next.trim();
            if (clean && clean !== kr.title) patch({ title: clean });
          }}
          aria-label="KR 제목"
        />
        <ProgressTrack ratio={progress} />
      </div>

      {kr.kind === "metric" ? (
        <div className="mission-kr-metric" aria-label="수치형 KR 값">
          <DraftInput
            value={numberDraft(kr.currentValue)}
            disabled={readOnly}
            onCommit={(next) => patch({ currentValue: parseNullableNumber(next) })}
            inputMode="decimal"
            aria-label="현재값"
          />
          <span className="mission-muted typo-label-sm">/</span>
          <DraftInput
            value={numberDraft(kr.targetValue)}
            disabled={readOnly}
            onCommit={(next) => patch({ targetValue: parseNullableNumber(next) })}
            inputMode="decimal"
            aria-label="목표값"
          />
          <DraftInput
            value={kr.unit ?? ""}
            disabled={readOnly}
            onCommit={(next) => patch({ unit: next.trim() || null })}
            aria-label="단위"
          />
        </div>
      ) : (
        <MilestonePopover kr={kr} readOnly={readOnly} onPatch={patch} pending={pending} />
      )}

      <ConfidenceBadge checkIn={latestCheckIn} />
      {!readOnly && (
        <ArmedDeleteButton
          disabled={pending}
          ariaLabel="KR 삭제"
          onConfirm={() => void deleteKeyResult.mutateAsync(kr.id)}
        />
      )}
    </div>
  );
}

/**
 * 마일스톤 체크리스트 — 토글/추가 즉시 저장(별도 "적용" 버튼 없음).
 * 종전엔 로컬 draft에 쌓고 적용을 눌러야 했는데, 팝오버를 닫으면 조용히 유실됐다.
 */
function MilestonePopover({
  kr,
  readOnly,
  onPatch,
  pending,
}: {
  kr: KeyResult;
  readOnly: boolean;
  onPatch: (partial: { milestones: OkrMilestone[] }) => void;
  pending: boolean;
}) {
  const [newMilestone, setNewMilestone] = useState("");
  const done = kr.milestones.filter((milestone) => milestone.done).length;

  const toggle = (index: number, checked: boolean) => {
    onPatch({
      milestones: kr.milestones.map((item, itemIndex) =>
        itemIndex === index ? { ...item, done: checked } : item,
      ),
    });
  };

  const addMilestone = () => {
    const label = newMilestone.trim();
    if (!label) return;
    onPatch({ milestones: [...kr.milestones, { label, done: false }] });
    setNewMilestone("");
  };

  const removeMilestone = (index: number) => {
    onPatch({ milestones: kr.milestones.filter((_, itemIndex) => itemIndex !== index) });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="mission-kr-checklist">
          <ListChecks className="size-4" />
          체크리스트 {done}/{kr.milestones.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="mission-milestone-popover" align="end">
        <div className="mission-popover-head">
          <span className="typo-title-sm">마일스톤</span>
          <span className="mission-muted typo-caption-sm">
            {done}/{kr.milestones.length} · 체크 즉시 저장
          </span>
        </div>
        <div className="mission-milestone-list">
          {kr.milestones.map((milestone, index) => (
            <div key={`${milestone.label}-${index}`} className="mission-milestone-row">
              <label className="mission-check-row">
                <Checkbox
                  checked={milestone.done}
                  disabled={readOnly || pending}
                  onCheckedChange={(checked) => toggle(index, checked === true)}
                />
                <span className="typo-body-md">{milestone.label}</span>
              </label>
              {!readOnly && (
                <button
                  type="button"
                  className="mission-milestone-remove"
                  aria-label={`${milestone.label} 삭제`}
                  disabled={pending}
                  onClick={() => removeMilestone(index)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {kr.milestones.length === 0 && (
            <span className="mission-muted typo-body-md">마일스톤 없음</span>
          )}
        </div>
        {!readOnly && (
          <div className="mission-milestone-add">
            <Input
              value={newMilestone}
              onChange={(event) => setNewMilestone(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addMilestone();
                }
              }}
              placeholder="새 항목 (Enter로 추가)"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={addMilestone}
            >
              추가
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function ConfidenceBadge({ checkIn }: { checkIn: OkrCheckIn | null }) {
  const confidence = checkIn?.confidence ?? null;
  return (
    <span className="mission-confidence typo-caption-sm" data-confidence={confidence ?? "none"}>
      <span className="mission-confidence-dot" aria-hidden="true" />
      <span>{confidence ? CONFIDENCE_LABELS[confidence] : "체크인 없음"}</span>
    </span>
  );
}

export function ProgressTrack({ ratio }: { ratio: number }) {
  return (
    <span className="mission-progress" aria-label={`진척 ${Math.round(ratio * 100)}%`}>
      <span className="mission-progress-fill" style={{ width: `${barPercent(ratio)}%` }} />
    </span>
  );
}

function numberDraft(value: number | null): string {
  return value == null ? "" : String(value);
}

function barPercent(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
