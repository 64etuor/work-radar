import { useState } from "react";

import type { Skill, SkillRef } from "@/bindings";
import {
  useApplyManagedSkills,
  useDeleteSkill,
  useSetSkillTags,
  useUnapplyManagedSkills,
  useUpdateSkill,
} from "@/lib/query";
import {
  addTagToSkill,
  batchApplyTargets,
  batchMutableTargets,
  batchTaggableTargets,
  selectedSkills,
  summarizeBatch,
} from "@/lib/skillBatch";

export interface SkillBatchSelectionResult {
  // state
  selectedIds: ReadonlySet<string>;
  batchTag: string;
  setBatchTag: (v: string) => void;
  batchNote: string | null;
  batchNoteErr: boolean;
  // derived
  selCount: number;
  mutableTargets: Skill[];
  taggableTargets: Skill[];
  applyTargets: Skill[];
  batchBusy: boolean;
  batchApplyBusy: boolean;
  applyBatch: ReturnType<typeof useApplyManagedSkills>;
  unapplyBatch: ReturnType<typeof useUnapplyManagedSkills>;
  // callbacks
  toggleSelectGroup: (ids: string[]) => void;
  clearSelection: () => void;
  batchToggle: (enabled: boolean) => void;
  batchAddTag: () => void;
  batchRemove: () => void;
  runBatchApply: (remove: boolean) => void;
  toRefs: (skills: Skill[]) => SkillRef[];
}

/**
 * 다중 선택 + 배치 조작 상태 기계(#9). 인앱 프롬프트 토글/삭제/태깅과 managed 스킬 배치 적용/해제를
 * 하나의 훅으로 캡슐화한다. SkillsView가 소비하며 list(전체 스킬 목록)를 입력으로 받는다.
 */
export function useSkillBatchSelection(list: Skill[]): SkillBatchSelectionResult {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [batchTag, setBatchTag] = useState("");
  const [batchNote, setBatchNote] = useState<string | null>(null);
  // 배치 노트가 오류 스타일(빨강)인지 — 기본 true(실패 메시지가 다수). 적용/해제 성공 요약만 false(중립).
  const [batchNoteErr, setBatchNoteErr] = useState(true);

  const batchUpdate = useUpdateSkill();
  const batchDelete = useDeleteSkill();
  const batchSetTags = useSetSkillTags();
  const applyBatch = useApplyManagedSkills();
  const unapplyBatch = useUnapplyManagedSkills();

  const selCount = selectedSkills(list, selectedIds).length;
  const mutableTargets = batchMutableTargets(list, selectedIds);
  const taggableTargets = batchTaggableTargets(list, selectedIds);
  const applyTargets = batchApplyTargets(list, selectedIds);
  const batchBusy = batchUpdate.isPending || batchDelete.isPending || batchSetTags.isPending;
  const batchApplyBusy = applyBatch.isPending || unapplyBatch.isPending;

  // 그룹 카드 체크박스(#4): 멤버 전체를 한 번에 켜고/끈다. 모두 선택돼 있으면 해제, 아니면 전체 선택.
  const toggleSelectGroup = (ids: string[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBatchNote(null);
    setBatchNoteErr(true);
  };

  // 배치 결과 정리: 성공한 항목만 선택 해제하고(실패는 재시도 가능하게 선택 유지), 실패 수를 노출한다.
  const finishBatch = (targets: Skill[], results: PromiseSettledResult<unknown>[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      targets.forEach((t, i) => {
        if (results[i]?.status === "fulfilled") next.delete(t.id);
      });
      return next;
    });
    const failed = results.filter((r) => r.status === "rejected").length;
    setBatchNote(failed > 0 ? `${failed}개 실패 — 다시 시도하세요` : null);
    setBatchNoteErr(true); // 토글/태그/삭제 배치 노트는 항상 오류 스타일(실패 메시지).
  };

  const batchToggle = (enabled: boolean) => {
    if (batchBusy) return;
    setBatchNote(null);
    const targets = mutableTargets;
    Promise.allSettled(targets.map((s) => batchUpdate.mutateAsync({ id: s.id, enabled }))).then(
      (results) => finishBatch(targets, results),
    );
  };

  const batchAddTag = () => {
    const t = batchTag.trim();
    if (!t || batchBusy) return;
    setBatchTag("");
    setBatchNote(null);
    const targets = taggableTargets;
    Promise.allSettled(
      targets.map((s) => batchSetTags.mutateAsync({ skillKey: s.id, tags: addTagToSkill(s, t) })),
    ).then((results) => finishBatch(targets, results));
  };

  const batchRemove = () => {
    if (batchBusy || mutableTargets.length === 0) return;
    if (
      !window.confirm(
        `선택한 인앱 프롬프트 ${mutableTargets.length}개를 삭제할까요? (외부 스킬은 제외)`,
      )
    )
      return;
    setBatchNote(null);
    const targets = mutableTargets;
    Promise.allSettled(targets.map((s) => batchDelete.mutateAsync(s.id))).then((results) =>
      finishBatch(targets, results),
    );
  };

  // batchApplyTargets가 provider != null만 통과시키므로 여기서 provider는 항상 존재한다.
  const toRefs = (skills: typeof applyTargets): SkillRef[] =>
    skills.map((s) => ({
      provider: s.provider as import("@/bindings").SkillProvider,
      name: s.name,
    }));

  const runBatchApply = (remove: boolean) => {
    if (batchApplyBusy || applyTargets.length === 0) return;
    setBatchNote(null);
    const refs = toRefs(applyTargets);
    const mut = remove ? unapplyBatch : applyBatch;
    mut.mutate(refs, {
      // clearSelection()이 batchNote/Err를 리셋하므로 요약·중립 플래그는 선택 해제 *후*에 설정한다.
      onSuccess: (results) => {
        clearSelection();
        setBatchNote(summarizeBatch(results));
        setBatchNoteErr(false); // 적용/해제 결과 요약은 중립(정보) 스타일.
      },
      onError: () => {
        setBatchNote("배치 적용에 실패했습니다");
        setBatchNoteErr(true);
      },
    });
  };

  return {
    selectedIds,
    batchTag,
    setBatchTag,
    batchNote,
    batchNoteErr,
    selCount,
    mutableTargets,
    taggableTargets,
    applyTargets,
    batchBusy,
    batchApplyBusy,
    applyBatch,
    unapplyBatch,
    toggleSelectGroup,
    clearSelection,
    batchToggle,
    batchAddTag,
    batchRemove,
    runBatchApply,
    toRefs,
  };
}
