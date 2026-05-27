import { Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Worktree } from "@/bindings";
import { useRebaseWorktree } from "@/lib/query";

export function RebaseBar({
  worktree,
  onReviewBase,
}: {
  worktree: Worktree;
  onReviewBase: () => void;
}) {
  const rebase = useRebaseWorktree();
  const base = "origin/dev";

  function run() {
    if (rebase.isPending) return;
    if (
      !window.confirm(
        `${worktree.branch ?? "(detached)"} 를 ${base} 위로 rebase합니다.\n` +
          "미커밋 변경이 있으면 거부되고, 충돌 시 자동으로 원상복구됩니다. 계속할까요?",
      )
    )
      return;
    rebase.mutate(
      { worktreePath: worktree.path, base },
      {
        onSuccess: (res) => {
          if (res.success) onReviewBase();
        },
      },
    );
  }

  const result = rebase.data;
  return (
    <div className="wt-rebase">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 rounded-full text-[12px]"
        onClick={run}
        disabled={rebase.isPending || worktree.dirty}
        title={
          worktree.dirty ? "미커밋 변경이 있어 rebase할 수 없습니다" : `${base} 위로 안전 rebase`
        }
      >
        <Waypoints className="size-3.5" />
        {rebase.isPending ? "rebase 중…" : `${base} rebase`}
      </Button>
      {rebase.error && (
        <span className="wt-rebase-msg wt-rebase-err">{(rebase.error as Error).message}</span>
      )}
      {result && (
        <span className={`wt-rebase-msg${result.success ? "wt-rebase-ok" : "wt-rebase-err"}`}>
          {result.success ? "rebase 성공 — vs Base로 검수하세요." : result.message}
        </span>
      )}
    </div>
  );
}
