import { ArrowDownToLine, ArrowUpFromLine, GitCompare } from "lucide-react";
import { useState } from "react";

import type { SkillDiff, SkillProvider } from "@/bindings";
import { Button } from "@/components/ui/button";
import { lineDiff } from "@/lib/lineDiff";
import { usePullDivergence, usePushDivergence, useSkillDiff } from "@/lib/query";

import { SkillPromptDiff } from "./SkillPromptDiff";

/** diverged 프로젝트 카피 ↔ 중앙 트리 차이 본문(G3-PR2c — 표시 전용). added/removed는 파일명, changed는
 *  파일별 lineDiff(중앙=base, 프로젝트=current). 인라인 렌더(중첩 overlay 없음 — Esc 계약 보존). */
function DivergenceDiffBody({ diff }: { diff: SkillDiff }) {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return <div className="skl-note">차이 없음 (이미 동기화됨)</div>;
  }
  return (
    <div className="skl-vendor-diff-body">
      {diff.removed.map((p) => (
        <div key={`r-${p}`} className="skl-diff-line skl-diff-remove">
          <span className="skl-diff-gutter" aria-hidden="true">
            −
          </span>
          <span className="skl-diff-text">{p} (중앙에만)</span>
        </div>
      ))}
      {diff.added.map((p) => (
        <div key={`a-${p}`} className="skl-diff-line skl-diff-add">
          <span className="skl-diff-gutter" aria-hidden="true">
            +
          </span>
          <span className="skl-diff-text">{p} (프로젝트에만)</span>
        </div>
      ))}
      {diff.changed.map((f) => (
        <div key={`c-${f.relPath}`} className="skl-vendor-diff-file">
          <div className="skl-vendor-diff-fname">{f.relPath}</div>
          <SkillPromptDiff lines={lineDiff(f.centralText, f.projectText)} />
        </div>
      ))}
    </div>
  );
}

/** diverged 카피 해소 컨트롤(G3-PR2c, 레일 ①). "해소…"를 펼치면 인라인 diff + 두 2-step-confirm 액션:
 *  pull(중앙→프로젝트, 프로젝트 편집 버림·git이 undo) / push(프로젝트→중앙, 사전 백업으로 가역).
 *  인라인만 — 중첩 Sheet/Dialog 금지(overlay-stack Esc 계약). diff는 펼칠 때만 fetch(enabled). */
export function DivergenceResolver({
  repoId,
  provider,
  name,
  onResolved,
}: {
  repoId: string;
  provider: SkillProvider;
  name: string;
  onResolved: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "pull" | "push">(null);
  const diff = useSkillDiff({ repoId, provider, name }, open);
  const pull = usePullDivergence();
  const push = usePushDivergence();
  const busy = pull.isPending || push.isPending;

  const close = () => {
    setOpen(false);
    setConfirm(null);
  };
  const doPull = () => {
    if (busy) return;
    pull.mutate(
      { repoId, provider, name },
      {
        onSuccess: () => {
          onResolved("중앙으로 되돌림 (프로젝트 카피 = 중앙 내용)");
          close();
        },
        onError: (e) => onResolved(`되돌리기 실패: ${(e as Error).message}`),
      },
    );
  };
  const doPush = () => {
    if (busy) return;
    push.mutate(
      { repoId, provider, name },
      {
        onSuccess: () => {
          onResolved("중앙에 반영함 (사전 백업 생성 · 복원 패널에서 되돌림)");
          close();
        },
        onError: (e) => onResolved(`반영 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-vendor-resolve">
      <Button
        variant="ghost"
        className="gap-1.5 rounded-full"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
      >
        <GitCompare className="size-4" />
        {open ? "닫기" : "변경됨 · 해소…"}
      </Button>
      {open && (
        <section className="skl-vendor-resolve-body" aria-label="중앙과의 차이 · 해소">
          {diff.isLoading && <div className="skl-note">차이 불러오는 중…</div>}
          {diff.isError && <div className="skl-note">차이를 불러오지 못했습니다.</div>}
          {diff.data && <DivergenceDiffBody diff={diff.data} />}
          <div className="skl-vendor-resolve-actions">
            {confirm === "pull" ? (
              <Button variant="destructive" onClick={doPull} disabled={busy}>
                되돌리기 확인? (프로젝트 편집 버림)
              </Button>
            ) : (
              <Button
                variant="outline"
                className="gap-1.5 rounded-full"
                onClick={() => setConfirm("pull")}
                disabled={busy}
              >
                <ArrowDownToLine className="size-4" />
                중앙으로 되돌리기
              </Button>
            )}
            {confirm === "push" ? (
              <Button variant="destructive" onClick={doPush} disabled={busy}>
                반영 확인? (중앙 백업됨)
              </Button>
            ) : (
              <Button
                variant="outline"
                className="gap-1.5 rounded-full"
                onClick={() => setConfirm("push")}
                disabled={busy}
              >
                <ArrowUpFromLine className="size-4" />
                중앙에 반영
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
