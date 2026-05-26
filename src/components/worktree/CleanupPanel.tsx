import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import type { CleanupCandidate } from "@/bindings";
import { useCleanupCandidates, useDeleteCleanupCandidates } from "@/lib/query";

const CLEANUP_KIND_LABEL: Record<CleanupCandidate["kind"], string> = {
  merged_branch: "머지됨",
  stale_branch: "오래됨",
  prunable_worktree: "prune",
};

/**
 * 브랜치/워크트리 정리 패널 (Phase 12d). merged/stale 브랜치 + prunable worktree를 다중 선택해
 * 확인 후 삭제. 보호 항목(현재/base/dirty)은 선택 불가, 미머지는 force 토글이 켜져야 선택 가능.
 */
export function CleanupPanel({
  repoPath,
  base,
  onClose,
}: {
  repoPath: string;
  base: string;
  onClose: () => void;
}) {
  const candidates = useCleanupCandidates(repoPath, base);
  const del = useDeleteCleanupCandidates();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [force, setForce] = useState(false);

  const list = candidates.data ?? [];

  // 선택 가능 = 비보호 && (force 불필요 || force 켜짐).
  function selectable(c: CleanupCandidate): boolean {
    return !c.protected && (!c.needsForce || force);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run() {
    const ids = [...selected];
    if (ids.length === 0 || del.isPending) return;
    if (!window.confirm(`${ids.length}개 항목을 삭제합니다. 계속할까요?`)) return;
    del.mutate(
      { repoPath, base, ids, force },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  return (
    <div className="wt-cleanup">
      <div className="wt-cleanup-head">
        <span className="wt-cleanup-title">브랜치 / 워크트리 정리</span>
        <span className="wt-cleanup-base">기준: {base}</span>
        <label className="wt-cleanup-force">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => {
              setForce(e.target.checked);
              if (!e.target.checked) {
                // force 끄면 force-필요 항목 선택 해제.
                setSelected((prev) => {
                  const next = new Set(prev);
                  for (const c of list) {
                    if (c.needsForce && next.has(c.id)) next.delete(c.id);
                  }
                  return next;
                });
              }
            }}
          />
          미머지 강제 삭제(force)
        </label>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto rounded-full text-[12px]"
          onClick={onClose}
        >
          닫기
        </Button>
      </div>

      {candidates.isLoading && (
        <div className="wt-empty">
          <Spinner />
        </div>
      )}
      {candidates.error && (
        <div className="wt-err">{(candidates.error as Error).message}</div>
      )}
      {!candidates.isLoading && list.length === 0 && !candidates.error && (
        <div className="wt-empty">정리할 후보가 없습니다.</div>
      )}

      <div className="wt-cleanup-list">
        {list.map((c) => {
          const can = selectable(c);
          return (
            <label
              key={c.id}
              className={`wt-cleanup-row${can ? "" : " wt-cleanup-locked"}`}
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                disabled={!can}
                onChange={() => toggle(c.id)}
              />
              <span className={`wt-cleanup-kind wt-ck-${c.kind}`}>
                {CLEANUP_KIND_LABEL[c.kind]}
              </span>
              <span className="wt-cleanup-name">{c.name}</span>
              <span className="wt-cleanup-detail">{c.detail}</span>
            </label>
          );
        })}
      </div>

      <div className="wt-cleanup-foot">
        <Button
          variant="destructiveOutline"
          size="sm"
          className="gap-1.5 rounded-full text-[12px]"
          onClick={run}
          disabled={selected.size === 0 || del.isPending}
        >
          <Trash2 className="size-3.5" />
          {del.isPending ? "삭제 중…" : `선택 ${selected.size}개 삭제`}
        </Button>
        {del.error && (
          <span className="wt-cleanup-msg wt-rebase-err">
            {(del.error as Error).message}
          </span>
        )}
        {del.data && <span className="wt-cleanup-msg">{del.data}</span>}
      </div>
    </div>
  );
}
