import { Sparkles } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { quarterLabel } from "@/lib/okr";
import {
  useCodexStatus,
  useOkrImportActiveRun,
  useOkrImportAwaitingRun,
  useTriggerOkrImport,
} from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * OKR 받아쓰기 진입점 — 자유 텍스트를 붙여넣으면 codex 잡이 OKR 초안을 뽑고(awaiting_approval),
 * 사람이 AgentRunModal의 초안 패널에서 검토·편집 후 적용해야 생성된다(INVARIANT #1/#2).
 * 상태: 실행 중=비활성 라벨, 검토 대기=잡 모달 열기 버튼, 그 외=텍스트 입력 다이얼로그.
 */
export function OkrImportButton({ quarter }: { quarter: string }) {
  const codex = useCodexStatus();
  const trigger = useTriggerOkrImport();
  const activeRun = useOkrImportActiveRun();
  const awaitingRun = useOkrImportAwaitingRun();
  const setOpenAgentRunId = useUIStore((s) => s.setOpenAgentRunId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const codexReady = !!codex.data?.installed && !!codex.data?.authed;
  const running = activeRun != null && activeRun.status !== "awaiting_approval";

  if (awaitingRun) {
    return (
      <Button variant="outline" onClick={() => setOpenAgentRunId(awaitingRun.id)}>
        <Sparkles className="size-4" />
        받아쓰기 초안 검토
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={!codexReady || running}
        title={
          codexReady
            ? "자유 텍스트를 붙여넣으면 에이전트가 OKR 초안을 만듭니다 (적용은 검토 후 사람이)"
            : "codex CLI 설치/로그인 후 사용 가능"
        }
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" />
        {running ? "초안 생성 중…" : "받아쓰기 (AI)"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent className="mission-dialog" aria-describedby={undefined}>
            <DialogTitle>OKR 받아쓰기</DialogTitle>
            <p className="mission-muted typo-body-md">
              미션/장기 목표/Objective/KR이 섞인 자유 텍스트를 붙여넣으세요. 에이전트가{" "}
              {quarterLabel(quarter)} 초안으로 정리하면, 검토·편집 후 적용할 때만 생성됩니다.
            </p>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={12}
              placeholder={"예)\n장기 목표: …\n1년 목표: …\nObjective 1 … KR: …"}
              autoFocus
            />
            {trigger.error != null && (
              <p className="mission-error typo-label-sm">{(trigger.error as Error).message}</p>
            )}
            <div className="mission-dialog-actions">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                취소
              </Button>
              <Button
                type="button"
                disabled={trigger.isPending || text.trim().length === 0}
                onClick={() =>
                  trigger.mutate(
                    { text, quarter, timeoutSec: 240, maxTurns: 8, costCapUsd: 0.5 },
                    {
                      onSuccess: () => {
                        setText("");
                        setOpen(false);
                      },
                    },
                  )
                }
              >
                {trigger.isPending ? "시작 중…" : "초안 생성"}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
