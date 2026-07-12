import { type FormEvent, useState } from "react";

import type { Objective } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isComposingEnter } from "@/lib/ime";
import { useCloseObjective } from "@/lib/query";

export function CloseObjectiveDialog({
  objective,
  onOpenChange,
  returnFocusTo,
}: {
  objective: Objective | null;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: HTMLElement | null;
}) {
  return (
    <Dialog open={objective !== null} onOpenChange={onOpenChange}>
      {objective && (
        <CloseObjectiveBody
          key={objective.id}
          objective={objective}
          onDone={() => onOpenChange(false)}
          returnFocusTo={returnFocusTo}
        />
      )}
    </Dialog>
  );
}

function CloseObjectiveBody({
  objective,
  onDone,
  returnFocusTo,
}: {
  objective: Objective;
  onDone: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const [reflection, setReflection] = useState(objective.closedReflection ?? "");
  const closeObjective = useCloseObjective();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (closeObjective.isPending) return; // 빠른 더블-Enter 이중 마감 방지
    await closeObjective.mutateAsync({
      id: objective.id,
      reflection: reflection.trim() || null,
    });
    onDone();
  };

  return (
    <DialogContent
      className="mission-dialog"
      aria-describedby={undefined}
      onCloseAutoFocus={(event) => restoreFocusOnClose(event, returnFocusTo)}
    >
      <DialogTitle>분기 Objective 마감</DialogTitle>
      <form className="mission-dialog-form" onSubmit={submit}>
        <label className="mission-field">
          <span className="typo-label-sm">한 줄 회고</span>
          <Input
            value={reflection}
            onChange={(event) => setReflection(event.target.value)}
            onKeyDown={(event) => {
              if (isComposingEnter(event)) event.preventDefault(); // 조합 확정 Enter의 폼 제출 차단
            }}
            placeholder="무엇이 다음 분기에 남았나요?"
            autoFocus
          />
        </label>
        <div className="mission-dialog-actions">
          <Button type="button" variant="outline" onClick={onDone}>
            취소
          </Button>
          <Button type="submit" disabled={closeObjective.isPending}>
            마감
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
