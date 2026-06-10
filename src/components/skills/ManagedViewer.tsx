import { Library, Link2, Trash2, Unlink } from "lucide-react";
import { useState } from "react";

import type { Skill } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  useAppliedSkills,
  useApplyManagedSkill,
  useRemoveManagedSkill,
  useUnapplyManagedSkill,
} from "@/lib/query";
import { providerLabel } from "@/lib/skillBadges";

import { SkillTagsEditor } from "./SkillTagsEditor";
import { VendorPanel } from "./VendorPanel";

/** 라이브러리(managed) 스킬 뷰어 — work-radar가 소유한 중앙 라이브러리 스킬(G1-PR3). 메타데이터 + 제거.
 * 중앙 파일 내용 뷰어는 G1 비대상(readExternalSkill 가드가 외부 루트 전용 — 중앙 경로 비대상). "라이브러리
 * 에서 제거"는 중앙 복사본만 지운다(외부 원본 무손상, 감사 — 레일 ①②). 자동 실행 없음(#1/#2). */
export function ManagedViewer({ skill, onRemoved }: { skill: Skill; onRemoved: () => void }) {
  const remove = useRemoveManagedSkill();
  const applied = useAppliedSkills();
  const apply = useApplyManagedSkill();
  const unapply = useUnapplyManagedSkill();
  const [note, setNote] = useState<string | null>(null);
  const desc = (skill.prompt ?? "").trim();

  // 적용 상태는 디스크 심링크에서 유도(레일 ①, INVARIANT #7) — provider+name으로 매칭.
  const appliedEntry = (applied.data ?? []).find(
    (a) => a.provider === skill.provider && a.name === skill.name,
  );
  const isApplied = !!appliedEntry;
  const applyBusy = apply.isPending || unapply.isPending;

  const removeFromLibrary = () => {
    if (!skill.provider || remove.isPending) return;
    if (
      !window.confirm(
        `'${skill.name}'을(를) 라이브러리에서 제거할까요? (원본 외부 파일은 그대로 유지됩니다)`,
      )
    )
      return;
    setNote(null);
    remove.mutate(
      { provider: skill.provider, name: skill.name },
      {
        onSuccess: onRemoved,
        onError: (e) => setNote(`제거 실패: ${(e as Error).message}`),
      },
    );
  };

  const applyToAgent = () => {
    if (!skill.provider || applyBusy) return;
    setNote(null);
    apply.mutate(
      { provider: skill.provider, name: skill.name },
      {
        onSuccess: (path) => setNote(`적용됨 → ${path}`),
        onError: (e) => setNote(`적용 실패: ${(e as Error).message}`),
      },
    );
  };

  const unapplyFromAgent = () => {
    if (!skill.provider || applyBusy) return;
    setNote(null);
    unapply.mutate(
      { provider: skill.provider, name: skill.name },
      {
        onSuccess: () => setNote("적용 해제됨 (심링크 제거 · 사용자 파일 무손상)"),
        onError: (e) => setNote(`해제 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <span className="skl-name-static">{skill.name}</span>
        <Button
          variant="outline"
          className="gap-1.5 rounded-full"
          onClick={removeFromLibrary}
          disabled={!skill.provider || remove.isPending}
        >
          <Trash2 className="size-4" />
          {remove.isPending ? "제거 중…" : "라이브러리에서 제거"}
        </Button>
      </div>

      <div className="skl-bind-line">
        <Library className="mr-1 inline size-3.5 align-text-bottom" />
        라이브러리 관리 중 · 출처 {providerLabel(skill.provider)}
        {isApplied && " · 에이전트에 적용됨"}
      </div>
      {desc && <div className="skl-desc">{desc}</div>}

      {/* 에이전트 dir 적용/해제(G2-PR1, ADR-0006 레일 ① — 심링크, 가역·감사). 인라인 — Dialog 없음. */}
      <div className="skl-actions">
        {isApplied ? (
          <Button
            variant="outline"
            className="gap-1.5 rounded-full"
            onClick={unapplyFromAgent}
            disabled={!skill.provider || applyBusy}
          >
            <Unlink className="size-4" />
            {unapply.isPending ? "해제 중…" : "적용 해제"}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="gap-1.5 rounded-full"
            onClick={applyToAgent}
            disabled={!skill.provider || applyBusy}
          >
            <Link2 className="size-4" />
            {apply.isPending ? "적용 중…" : `${providerLabel(skill.provider)}에 적용`}
          </Button>
        )}
      </div>

      <VendorPanel skill={skill} />

      <SkillTagsEditor skill={skill} />

      {note && <div className="skl-note">{note}</div>}
    </div>
  );
}
