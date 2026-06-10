import { type KeyboardEvent, useState } from "react";

import type { Project, ProjectKind } from "@/bindings";
import { cn } from "@/components/ui/cn";
import { useSetProjectKind, useSetProjectName } from "@/lib/query";

import { Segmented } from "../SettingsKit";

/**
 * 프로젝트 이름(더블클릭 인라인 편집) + 종류(개인/업무 Segmented 즉시 전환).
 * 이름: Enter/blur 저장, Esc 취소(셸 window-level Esc로 버블 방지), 공백 이름 거부.
 * kind: 토글 즉시 mutate — 라우팅 카테고리만 이동(기존 신호 재태깅 없음).
 */
export function ProjectIdentityEditor({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const setName = useSetProjectName();
  const setKind = useSetProjectKind();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);

  const beginEdit = () => {
    setDraft(project.name);
    setEditing(true);
  };

  // 이름·kind는 각각 단일 컬럼만 갱신하는 독립 커맨드 → 교차 필드(stale prop)를 읽지 않는다(lost-update 방지).
  const commitName = () => {
    const trimmed = draft.trim();
    if (!trimmed) return; // 빈 이름 거부 — 편집 모드 유지(테두리 경고).
    if (trimmed === project.name) {
      setEditing(false);
      return;
    }
    setName.mutate(
      { projectId: project.id, name: trimmed },
      {
        onSuccess: () => setEditing(false),
        onError: () => onToast("이름 저장 실패"),
      },
    );
  };

  const onNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitName();
    } else if (e.key === "Escape") {
      e.stopPropagation(); // App 셸 window-level Esc(보드 복귀/창 숨김)로 버블 방지.
      setEditing(false);
    }
  };

  const changeKind = (kind: ProjectKind) => {
    if (kind === project.kind) return;
    setKind.mutate({ projectId: project.id, kind }, { onError: () => onToast("종류 저장 실패") });
  };

  const empty = !draft.trim();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onNameKeyDown}
          onBlur={commitName}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
          disabled={setName.isPending}
          aria-invalid={empty || undefined}
          aria-label="프로젝트 이름"
          className={cn(
            "h-auto min-w-0 flex-1 border-0 border-b bg-transparent px-0 py-0 outline-none",
            "typo-title-md disabled:opacity-50",
            empty ? "border-destructive" : "border-input focus:border-ring focus:border-b-2",
          )}
        />
      ) : (
        <span
          className="typo-title-md cursor-text truncate"
          onDoubleClick={beginEdit}
          title="더블클릭하여 이름 편집"
        >
          {project.name}
        </span>
      )}
      <Segmented
        value={project.kind}
        onChange={changeKind}
        options={[
          { value: "personal", label: "개인" },
          { value: "work", label: "업무" },
        ]}
        size="sm"
      />
    </div>
  );
}
