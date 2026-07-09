import { GitCompare, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Skill } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { diffStats, lineDiff } from "@/lib/lineDiff";
import { useDeleteSkill, useUpdateSkill } from "@/lib/query";

import { SkillPromptDiff } from "./SkillPromptDiff";
import { SkillTagsEditor } from "./SkillTagsEditor";

/** 인앱 프롬프트 편집기: 이름 + 텍스트에어리어(템플릿) + enable 토글 + 저장/삭제. */
export function InAppEditor({ skill }: { skill: Skill }) {
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  const [prompt, setPrompt] = useState(() => skill.prompt ?? "");
  const [name, setName] = useState(() => skill.name);
  const [note, setNote] = useState<string | null>(null);
  // 기본값(코드 상수)과의 diff 펼침 여부(#18). 스킬 전환 시 초기화.
  const [showDiff, setShowDiff] = useState(false);

  const dirty = prompt !== (skill.prompt ?? "") || name !== skill.name;

  // #18: 시드 binding을 가진 인앱 프롬프트만 코드 상수 폴백이 있다(외부/미시드는 null → diff 비대상).
  // 현재 편집본(prompt)을 기본값과 비교 — 같으면 "기본값과 동일", 다르면 diff/복원 노출.
  const fallback = skill.fallbackPrompt;
  const diff = fallback != null ? lineDiff(fallback, prompt) : [];
  const customized = fallback != null && prompt !== fallback;
  const stats = diffStats(diff);

  // 기본값으로 복원: prompt를 코드 상수로 되돌린다(로컬 상태 — 저장해야 영속, 가역). #1: 사람 발동.
  const resetToDefault = () => {
    if (fallback == null) return;
    setPrompt(fallback);
    setShowDiff(false);
    setNote("기본값으로 되돌렸습니다 — 저장하면 적용됩니다.");
  };

  const save = () => {
    if (update.isPending) return;
    setNote(null);
    update.mutate(
      { id: skill.id, prompt, name },
      {
        onSuccess: () => setNote("저장됨"),
        onError: (e) => setNote(`저장 실패: ${(e as Error).message}`),
      },
    );
  };

  const toggle = () => {
    if (update.isPending) return;
    update.mutate(
      { id: skill.id, enabled: !skill.enabled },
      {
        onError: (e) => setNote(`토글 실패: ${(e as Error).message}`),
      },
    );
  };

  const remove = () => {
    if (del.isPending) return;
    if (!confirm(`'${skill.name}' 인앱 프롬프트를 삭제할까요? (잡은 기본 프롬프트로 돌아갑니다)`))
      return;
    del.mutate(skill.id, {
      onError: (e) => setNote(`삭제 실패: ${(e as Error).message}`),
    });
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <Input
          className="flex-1 font-semibold"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="스킬 이름"
        />
        <label className="skl-toggle">
          <input type="checkbox" aria-label="스킬 활성" checked={skill.enabled} onChange={toggle} />
          <span>활성</span>
        </label>
      </div>

      {skill.binding && (
        <div className="skl-bind-line">
          잡 바인딩: <code>{skill.binding}</code> · 끄거나 비우면 잡이 기본 프롬프트를 사용합니다.
        </div>
      )}

      <Textarea
        className="min-h-[320px] resize-y font-mono leading-relaxed"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        spellCheck={false}
        aria-label="프롬프트 템플릿"
      />

      {fallback != null && (
        <div className="skl-fallback">
          {customized ? (
            <>
              <span className="skl-fallback-label">
                기본값과 다름{" "}
                <span className="skl-fallback-stat">
                  +{stats.added} −{stats.removed}
                </span>
              </span>
              <Button
                variant="ghost"
                size="pill-sm"
                className="gap-1.5"
                aria-pressed={showDiff}
                onClick={() => setShowDiff((v) => !v)}
              >
                <GitCompare className="size-4" />
                {showDiff ? "비교 숨기기" : "기본값과 비교"}
              </Button>
              <Button variant="ghost" size="pill-sm" className="gap-1.5" onClick={resetToDefault}>
                <RotateCcw className="size-4" />
                기본값으로 복원
              </Button>
            </>
          ) : (
            <span className="skl-fallback-label muted">기본값과 동일</span>
          )}
        </div>
      )}

      {customized && showDiff && <SkillPromptDiff lines={diff} />}

      <div className="skl-actions">
        <Button
          size="pill"
          className="gap-1.5 px-4"
          onClick={save}
          disabled={!dirty || update.isPending}
        >
          <Save className="size-4" />
          {update.isPending ? "저장 중…" : "저장"}
        </Button>
        <Button
          variant="outline"
          size="pill"
          className="gap-1.5 px-4"
          onClick={remove}
          disabled={del.isPending}
        >
          <Trash2 className="size-4" />
          삭제
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>

      <SkillTagsEditor skill={skill} />
    </div>
  );
}
