import { CopyPlus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { adjacentQuarter, quarterLabel } from "@/lib/okr";
import {
  useCreateKeyResult,
  useCreateObjective,
  useLinkObjectiveHorizon,
  useObjectiveHorizonLinks,
  useObjectives,
} from "@/lib/query";

/**
 * 지난 분기 활성 Objective 이월(복제) — 제목/설명/링크/KR 구조·현재값·장기목표 링크까지 그대로
 * 새 분기에 만든다. 지난 분기 원본은 건드리지 않는다(마감은 사용자 결정 — INVARIANT #1).
 * 기존 IPC(createObjective/createKeyResult/linkObjectiveHorizon)만 사용.
 */
export function RolloverFromPrevQuarter({ quarter }: { quarter: string }) {
  const prevQuarter = adjacentQuarter(quarter, -1);
  const prevObjectives = useObjectives(prevQuarter);
  const prevLinks = useObjectiveHorizonLinks(prevQuarter);
  const createObjective = useCreateObjective();
  const createKeyResult = useCreateKeyResult();
  const linkHorizon = useLinkObjectiveHorizon();
  const [running, setRunning] = useState(false);

  const actives = (prevObjectives.data ?? [])
    .filter((objective) => objective.status === "active")
    .sort((a, b) => a.sortRank - b.sortRank);
  if (actives.length === 0) return null;

  const horizonIdsByObjective = new Map<string, string[]>();
  for (const link of prevLinks.data ?? []) {
    const ids = horizonIdsByObjective.get(link.objectiveId) ?? [];
    ids.push(link.horizonId);
    horizonIdsByObjective.set(link.objectiveId, ids);
  }

  const rollover = async () => {
    setRunning(true);
    try {
      for (const [index, objective] of actives.entries()) {
        const created = await createObjective.mutateAsync({
          quarter,
          title: objective.title,
          description: objective.description,
          sortRank: index,
          linkedAreaKeys: objective.linkedAreaKeys,
          linkedProjectIds: objective.linkedProjectIds,
        });
        for (const kr of [...objective.keyResults].sort((a, b) => a.sortRank - b.sortRank)) {
          await createKeyResult.mutateAsync({
            objectiveId: created.id,
            title: kr.title,
            kind: kr.kind,
            currentValue: kr.currentValue,
            targetValue: kr.targetValue,
            unit: kr.unit,
            milestones: kr.milestones,
            sortRank: kr.sortRank,
          });
        }
        for (const horizonId of horizonIdsByObjective.get(objective.id) ?? []) {
          await linkHorizon.mutateAsync({ objectiveId: created.id, horizonId });
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={running}
      title={`${quarterLabel(prevQuarter)} 활성 Objective ${actives.length}개를 이 분기로 복제합니다 (원본 유지)`}
      onClick={() => void rollover()}
    >
      <CopyPlus className="size-4" />
      {running ? "이월 중…" : `${quarterLabel(prevQuarter)}에서 이월 (${actives.length})`}
    </Button>
  );
}
