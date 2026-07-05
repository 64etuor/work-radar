import { ClipboardCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { KeyResult, Objective, OkrCheckIn, OkrConfidence, OkrMilestone } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { keyResultProgressRatio } from "@/lib/okr";
import { useUpdateKeyResult, useUpsertOkrCheckIn } from "@/lib/query";

import { ProgressTrack } from "./KeyResultRow";
import { CONFIDENCE_LABELS, parseNullableNumber } from "./okrControls";

type PendingCheckIn = {
  objectiveTitle: string;
  kr: KeyResult;
};

export function WeeklyCheckInPanel({
  objectives,
  checkIns,
  weekStart,
}: {
  objectives: Objective[];
  checkIns: OkrCheckIn[];
  weekStart: string;
}) {
  const checkedThisWeek = new Set(
    checkIns
      .filter((checkIn) => checkIn.weekStart === weekStart)
      .map((checkIn) => checkIn.keyResultId),
  );
  // 루틴 연결 KR은 제외 — 진행이 루틴 체크에서 자동 파생되므로 여기서 할 입력이 없다.
  const pending = objectives
    .filter((objective) => objective.status === "active")
    .flatMap((objective) =>
      objective.keyResults
        .filter((kr) => kr.routineId == null && !checkedThisWeek.has(kr.id))
        .map((kr) => ({ objectiveTitle: objective.title, kr })),
    );

  return (
    <section className="mission-checkin-panel">
      <div className="mission-panel-head">
        <div>
          <span className="mission-eyebrow typo-mono-label">
            <ClipboardCheck className="size-4" />
            주간 체크인
          </span>
          <h2 className="mission-panel-title typo-title-md">이번 주 미체크 KR</h2>
        </div>
        <span className="mission-count-pill typo-mono-label">{pending.length}개 남음</span>
      </div>
      {pending.length === 0 ? (
        <div className="mission-empty-line typo-body-md">이번 주 OKR 체크인이 끝났습니다.</div>
      ) : (
        <div className="mission-checkin-list">
          {pending.map((item) => (
            <CheckInDraft
              key={`${item.kr.id}:${item.kr.updatedAt}`}
              item={item}
              weekStart={weekStart}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CheckInDraft({ item, weekStart }: { item: PendingCheckIn; weekStart: string }) {
  const { kr } = item;
  const updateKeyResult = useUpdateKeyResult();
  const upsertCheckIn = useUpsertOkrCheckIn();
  const [current, setCurrent] = useState(kr.currentValue == null ? "" : String(kr.currentValue));
  const [milestones, setMilestones] = useState<OkrMilestone[]>(kr.milestones);
  const [confidence, setConfidence] = useState<OkrConfidence>("on_track");
  const [note, setNote] = useState("");
  const pending = updateKeyResult.isPending || upsertCheckIn.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (kr.kind === "metric") {
      const nextCurrent = parseNullableNumber(current);
      if (nextCurrent !== kr.currentValue) {
        await updateKeyResult.mutateAsync({
          id: kr.id,
          title: kr.title,
          kind: "metric",
          currentValue: nextCurrent,
          targetValue: kr.targetValue,
          unit: kr.unit,
          milestones: [],
          sortRank: kr.sortRank,
        });
      }
    } else if (JSON.stringify(milestones) !== JSON.stringify(kr.milestones)) {
      await updateKeyResult.mutateAsync({
        id: kr.id,
        title: kr.title,
        kind: "milestone",
        currentValue: null,
        targetValue: null,
        unit: null,
        milestones,
        sortRank: kr.sortRank,
      });
    }
    await upsertCheckIn.mutateAsync({
      keyResultId: kr.id,
      weekStart,
      confidence,
      note: note.trim() || null,
    });
    setNote("");
  };

  return (
    <form className="mission-checkin-item" onSubmit={submit}>
      <div className="mission-checkin-copy">
        <span className="mission-muted typo-caption-sm">{item.objectiveTitle}</span>
        <strong className="typo-title-sm">{kr.title}</strong>
        <ProgressTrack ratio={keyResultProgressRatio(kr)} />
      </div>

      {kr.kind === "metric" ? (
        <div className="mission-checkin-value">
          <Input
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            inputMode="decimal"
            aria-label="체크인 현재값"
          />
          <span className="mission-muted typo-label-sm">
            / {kr.targetValue ?? "-"} {kr.unit ?? ""}
          </span>
        </div>
      ) : (
        <div className="mission-checkin-milestones">
          {milestones.map((milestone, index) => (
            <label key={`${milestone.label}-${index}`} className="mission-check-row">
              <Checkbox
                checked={milestone.done}
                onCheckedChange={(checked) =>
                  setMilestones((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, done: checked === true } : item,
                    ),
                  )
                }
              />
              <span className="typo-body-md">{milestone.label}</span>
            </label>
          ))}
        </div>
      )}

      <div className="mission-confidence-buttons" aria-label="자신감">
        {(Object.keys(CONFIDENCE_LABELS) as OkrConfidence[]).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={confidence === value ? "default" : "outline"}
            aria-pressed={confidence === value}
            onClick={() => setConfidence(value)}
          >
            {CONFIDENCE_LABELS[value]}
          </Button>
        ))}
      </div>

      <Input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="한 줄 노트"
        aria-label="체크인 노트"
      />
      <Button type="submit" size="sm" disabled={pending}>
        기록
      </Button>
    </form>
  );
}
