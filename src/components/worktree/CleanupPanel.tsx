import { Trash2 } from "lucide-react";
import { useState } from "react";

import type { CleanupCandidate } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { useCleanupCandidates, useDeleteCleanupCandidates, useTriggerCodexJob } from "@/lib/query";

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
  const cleanupReview = useTriggerCodexJob();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [force, setForce] = useState(false);

  const list = candidates.data ?? [];
  const selectedItems = list.filter((c) => selected.has(c.id));
  const selectedProtected = selectedItems.filter((c) => c.protected).length;
  const selectedForce = selectedItems.filter((c) => c.needsForce).length;

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
    del.mutate({ repoPath, base, ids, force }, { onSuccess: () => setSelected(new Set()) });
  }

  function runAiReview() {
    const prompt = [
      "Use the editable in-app skill prompt named 'worktree cleanup 추천' as the policy baseline.",
      "Review these local cleanup candidates and recommend delete/keep/review.",
      `Repo path: ${repoPath}`,
      `Base: ${base}`,
      `Default stale threshold: 2 days with no activity.`,
      "Candidates:",
      ...list.map(
        (c) =>
          `- ${c.id}: kind=${c.kind}, name=${c.name}, protected=${c.protected}, needsForce=${c.needsForce}, detail=${c.detail}`,
      ),
      "Include evidence: merged state, stale inactivity, abandoned-branch pattern, review inactivity if inferable, and recovery risk.",
      "Do not delete anything. Return a concise recommendation table.",
    ].join("\n");
    cleanupReview.mutate({
      projectId: null,
      repoId: null,
      agentPromptBinding: "worktree_cleanup",
      prompt,
      timeoutSec: 120,
      maxTurns: 6,
      costCapUsd: 0.75,
    });
  }

  return (
    <div className="wt-cleanup">
      <div className="wt-cleanup-head">
        <span className="wt-cleanup-title">브랜치 / 워크트리 정리</span>
        <span className="wt-cleanup-base">기준: {base}</span>
        <label className="wt-cleanup-force">
          <input
            type="checkbox"
            aria-label="미머지 강제 삭제(force)"
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

      <div className="wt-cleanup-preview">
        <strong>삭제 preview</strong>
        <span>
          선택 {selected.size}개 · force 필요 {selectedForce}개 · 보호 항목 {selectedProtected}개
        </span>
        <p>
          삭제는 로컬 브랜치 삭제 또는 `git worktree prune`입니다. 이미 삭제된 항목은 git reflog나
          원격 브랜치가 없으면 앱에서 undo할 수 없습니다. 아래 근거를 확인한 항목만 선택하세요.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 rounded-full text-[12px]"
          disabled={list.length === 0 || cleanupReview.isPending}
          onClick={runAiReview}
          title="스킬 레지스트리의 editable cleanup prompt 기준으로 추천 잡을 생성합니다"
        >
          {cleanupReview.isPending ? "AI 추천 생성 중…" : "AI 추천 잡 생성"}
        </Button>
        {cleanupReview.data && (
          <span className="wt-cleanup-msg">추천 잡 생성됨: {cleanupReview.data}</span>
        )}
        {cleanupReview.error && (
          <span className="wt-cleanup-msg wt-rebase-err">
            {(cleanupReview.error as Error).message}
          </span>
        )}
      </div>

      {candidates.isLoading && (
        <div className="wt-empty">
          <Spinner />
        </div>
      )}
      {candidates.error && <div className="wt-err">{(candidates.error as Error).message}</div>}
      {!candidates.isLoading && list.length === 0 && !candidates.error && (
        <div className="wt-empty">정리할 후보가 없습니다.</div>
      )}

      <div className="wt-cleanup-list">
        {list.map((c) => {
          const can = selectable(c);
          return (
            <label key={c.id} className={`wt-cleanup-row${can ? "" : "wt-cleanup-locked"}`}>
              <input
                type="checkbox"
                aria-label={`${c.name} 선택`}
                checked={selected.has(c.id)}
                disabled={!can}
                onChange={() => toggle(c.id)}
              />
              <span className={`wt-cleanup-kind wt-ck-${c.kind}`}>
                {CLEANUP_KIND_LABEL[c.kind]}
              </span>
              <span className="wt-cleanup-name">{c.name}</span>
              <span className="wt-cleanup-detail">{c.detail}</span>
              <span className="wt-cleanup-reason">{cleanupReason(c)}</span>
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
          <span className="wt-cleanup-msg wt-rebase-err">{(del.error as Error).message}</span>
        )}
        {del.data && <span className="wt-cleanup-msg">{del.data}</span>}
      </div>
    </div>
  );
}

function cleanupReason(c: CleanupCandidate): string {
  if (c.protected) return "보호됨: 현재/base/dirty 항목은 삭제 대상에서 제외";
  if (c.kind === "merged_branch") return "기본 근거: base에 merge 완료";
  if (c.kind === "stale_branch") return "기본 근거: 2일 이상 최근 activity 없음";
  return "기본 근거: git prune 대상 worktree";
}
