import { FolderInput, Save } from "lucide-react";
import { useState } from "react";

import type { Skill } from "@/bindings";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useExternalSkillContent,
  useImportExternalSkill,
  useWriteExternalSkill,
} from "@/lib/query";

import { SkillTagsEditor } from "./SkillTagsEditor";

/** 외부 스킬 뷰어(SKILL.md 내용). 사용자 명시 편집 가능(자기 파일). 실행은 절대 없음.
 * "라이브러리로 import"는 이 스킬을 work-radar 중앙 라이브러리로 복사한다(가역·감사 — 레일 ①②). */
export function ExternalViewer({ skill, onImported }: { skill: Skill; onImported: () => void }) {
  const path = skill.sourcePath ?? null;
  const content = useExternalSkillContent(path);
  const write = useWriteExternalSkill();
  const importSkill = useImportExternalSkill();

  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const body = content.data ?? "";
  const dirty = editing && draft !== null && draft !== body;
  const canImport = !!path && !!skill.provider;

  const startEdit = () => {
    setDraft(body);
    setEditing(true);
    setNote(null);
  };

  const save = () => {
    if (!path || draft === null || write.isPending) return;
    write.mutate(
      { path, content: draft },
      {
        onSuccess: () => {
          setNote("파일 저장됨");
          setEditing(false);
        },
        onError: (e) => setNote(`저장 실패: ${(e as Error).message}`),
      },
    );
  };

  // 편집 취소: 초안을 버리고 읽기 모드로 복귀(파일 무변경).
  const cancelEdit = () => {
    if (write.isPending) return;
    setEditing(false);
    setDraft(null);
    setNote(null);
  };

  // 라이브러리로 import: 외부 파일은 읽기만 하고 중앙으로 복사(원본 무손상). 성공 시 목록이 갱신되며
  // 이 발견본은 managed로 대체(억제)되므로 Sheet를 닫는다. 자동 실행 없음(#1/#2 — 파일 복사일 뿐).
  const importToLibrary = () => {
    if (!path || !skill.provider || importSkill.isPending) return;
    setNote(null);
    importSkill.mutate(
      { path, provider: skill.provider },
      {
        onSuccess: onImported,
        onError: (e) => setNote(`import 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit fill">
      <div className="skl-edit-top">
        <span className="skl-name-static">{skill.name}</span>
        {!editing ? (
          <>
            {canImport && (
              <Button
                variant="outline"
                size="pill"
                className="gap-1.5 px-4"
                onClick={importToLibrary}
                disabled={importSkill.isPending}
                title="이 스킬을 work-radar 라이브러리로 복사(가역·감사)"
              >
                <FolderInput className="size-4" />
                {importSkill.isPending ? "import 중…" : "라이브러리로 import"}
              </Button>
            )}
            <Button size="pill" className="px-4" onClick={startEdit}>
              파일 편집
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="pill"
              className="px-4"
              onClick={cancelEdit}
              disabled={write.isPending}
            >
              취소
            </Button>
            <Button
              size="pill"
              className="gap-1.5 px-4"
              onClick={save}
              disabled={!dirty || write.isPending}
            >
              <Save className="size-4" />
              {write.isPending ? "저장 중…" : "파일 저장"}
            </Button>
          </>
        )}
      </div>

      <div className="skl-bind-line skl-path">{path}</div>
      {skill.prompt && <div className="skl-desc">{skill.prompt}</div>}

      <SkillTagsEditor skill={skill} />

      {content.isLoading ? (
        <div className="skl-empty-sm">불러오는 중…</div>
      ) : content.isError ? (
        <div className="skl-note err">
          파일을 읽지 못했습니다: {(content.error as Error).message}
        </div>
      ) : editing ? (
        <Textarea
          className="min-h-0 flex-1 resize-none font-mono leading-relaxed"
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label="외부 스킬 파일"
        />
      ) : (
        <SkillMarkdown body={body} />
      )}

      {note && <div className="skl-note">{note}</div>}
    </div>
  );
}
