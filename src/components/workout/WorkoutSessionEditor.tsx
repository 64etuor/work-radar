import { type FormEvent, useState } from "react";

import type { WorkoutSession } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePatchWorkoutSession } from "@/lib/query";

import { buildWorkoutSessionPatch, workoutSessionDraft } from "./workoutEditDrafts";

export function WorkoutSessionEditor({
  session,
  onClose,
}: {
  session: WorkoutSession;
  onClose: () => void;
}) {
  const patchSession = usePatchWorkoutSession();
  const [draft, setDraft] = useState(() => workoutSessionDraft(session));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    patchSession.mutate(buildWorkoutSessionPatch(session.id, draft), {
      onSuccess: onClose,
    });
  };

  return (
    <form className="wo-edit-form wo-session-edit" onSubmit={submit}>
      <label>
        <span className="typo-label-sm">날짜</span>
        <Input
          type="date"
          required
          value={draft.date}
          onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))}
        />
      </label>
      <label>
        <span className="typo-label-sm">제목</span>
        <Input
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </label>
      <label>
        <span className="typo-label-sm">시작</span>
        <Input
          type="time"
          value={draft.startedAt}
          onChange={(event) =>
            setDraft((current) => ({ ...current, startedAt: event.target.value }))
          }
        />
      </label>
      <label>
        <span className="typo-label-sm">종료</span>
        <Input
          type="time"
          value={draft.endedAt}
          onChange={(event) => setDraft((current) => ({ ...current, endedAt: event.target.value }))}
        />
      </label>
      <label>
        <span className="typo-label-sm">운동 강도</span>
        <Input
          type="number"
          min={1}
          max={10}
          value={draft.perceivedExertion}
          onChange={(event) =>
            setDraft((current) => ({ ...current, perceivedExertion: event.target.value }))
          }
        />
      </label>
      <label className="wo-edit-wide">
        <span className="typo-label-sm">메모</span>
        <Input
          value={draft.note}
          onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
        />
      </label>
      <div className="wo-edit-actions">
        <Button type="submit" size="sm" disabled={patchSession.isPending}>
          저장
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          취소
        </Button>
      </div>
    </form>
  );
}
