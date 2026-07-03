import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { LifeWheelTagConfig, Objective, Project } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateObjective, useDeleteObjective, useUpdateObjective } from "@/lib/query";

export function ObjectiveDialog({
  open,
  onOpenChange,
  objective,
  quarter,
  nextSortRank,
  tags,
  projects,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objective: Objective | null;
  quarter: string;
  nextSortRank: number;
  tags: LifeWheelTagConfig[];
  projects: Project[];
  returnFocusTo: HTMLElement | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <ObjectiveDialogBody
          key={objective?.id ?? `new-${quarter}`}
          objective={objective}
          quarter={quarter}
          nextSortRank={nextSortRank}
          tags={tags}
          projects={projects}
          onDone={() => onOpenChange(false)}
          returnFocusTo={returnFocusTo}
        />
      )}
    </Dialog>
  );
}

function ObjectiveDialogBody({
  objective,
  quarter,
  nextSortRank,
  tags,
  projects,
  onDone,
  returnFocusTo,
}: {
  objective: Objective | null;
  quarter: string;
  nextSortRank: number;
  tags: LifeWheelTagConfig[];
  projects: Project[];
  onDone: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const [title, setTitle] = useState(objective?.title ?? "");
  const [description, setDescription] = useState(objective?.description ?? "");
  const [areaKeys, setAreaKeys] = useState<string[]>(objective?.linkedAreaKeys ?? []);
  const [projectIds, setProjectIds] = useState<string[]>(objective?.linkedProjectIds ?? []);
  const createObjective = useCreateObjective();
  const updateObjective = useUpdateObjective();
  const deleteObjective = useDeleteObjective();

  const pending =
    createObjective.isPending || updateObjective.isPending || deleteObjective.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    const cleanDescription = description.trim() || null;
    if (objective) {
      await updateObjective.mutateAsync({
        id: objective.id,
        title: cleanTitle,
        description: cleanDescription,
        sortRank: objective.sortRank,
        linkedAreaKeys: areaKeys,
        linkedProjectIds: projectIds,
      });
    } else {
      await createObjective.mutateAsync({
        quarter,
        title: cleanTitle,
        description: cleanDescription,
        sortRank: nextSortRank,
        linkedAreaKeys: areaKeys,
        linkedProjectIds: projectIds,
      });
    }
    onDone();
  };

  const toggleArea = (tagId: string, checked: boolean) => {
    setAreaKeys((current) =>
      checked ? [...new Set([...current, tagId])] : current.filter((id) => id !== tagId),
    );
  };

  const toggleProject = (projectId: string, checked: boolean) => {
    setProjectIds((current) =>
      checked ? [...new Set([...current, projectId])] : current.filter((id) => id !== projectId),
    );
  };

  return (
    <DialogContent
      className="mission-dialog"
      aria-describedby={undefined}
      onCloseAutoFocus={(event) => restoreFocusOnClose(event, returnFocusTo)}
    >
      <DialogTitle>{objective ? "Objective 수정" : "Objective 추가"}</DialogTitle>
      <form className="mission-dialog-form" onSubmit={submit}>
        <label className="mission-field">
          <span className="typo-label-sm">제목</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </label>
        <label className="mission-field">
          <span className="typo-label-sm">설명</span>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </label>

        <div className="mission-pick-group">
          <span className="typo-label-sm">Life Wheel 태그</span>
          <div className="mission-check-grid">
            {tags
              .filter((tag) => tag.enabled)
              .map((tag) => (
                <label key={tag.id} className="mission-check-row">
                  <Checkbox
                    checked={areaKeys.includes(tag.id)}
                    onCheckedChange={(checked) => toggleArea(tag.id, checked === true)}
                  />
                  <span
                    className="mission-color-dot"
                    style={{ background: tag.color }}
                    aria-hidden="true"
                  />
                  <span className="typo-body-md">{tag.label}</span>
                </label>
              ))}
          </div>
        </div>

        <div className="mission-pick-group">
          <span className="typo-label-sm">프로젝트</span>
          <div className="mission-check-grid">
            {projects.map((project) => (
              <label key={project.id} className="mission-check-row">
                <Checkbox
                  checked={projectIds.includes(project.id)}
                  onCheckedChange={(checked) => toggleProject(project.id, checked === true)}
                />
                <span className="typo-body-md">{project.name}</span>
              </label>
            ))}
            {projects.length === 0 && (
              <span className="mission-muted typo-body-md">등록된 프로젝트가 없습니다.</span>
            )}
          </div>
        </div>

        <div className="mission-dialog-actions">
          {objective && (
            <Button
              type="button"
              variant="destructiveOutline"
              disabled={pending}
              onClick={() => {
                void deleteObjective.mutateAsync(objective.id).then(onDone);
              }}
            >
              <Trash2 className="size-4" />
              삭제
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onDone}>
            취소
          </Button>
          <Button type="submit" disabled={pending || title.trim().length === 0}>
            저장
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function restoreFocusOnClose(event: Event, returnFocusTo: HTMLElement | null) {
  if (!returnFocusTo?.isConnected) return;
  event.preventDefault();
  returnFocusTo.focus();
}
