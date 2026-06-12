import { GitMerge } from "lucide-react";

import type { UnmergedPlanBranch } from "../../bindings";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

/**
 * P4(a) — 완주-미머지 `boule/<planId>` 브랜치 "merge 대기 N" 칩. 프로젝트 바 우측,
 * 레포 coverage 칩과 같은 패턴(칩 + 툴팁 목록: 브랜치 · subject · ahead 수).
 * 0개면 아무것도 렌더하지 않는다(빈 상태 소음 금지). 표시 전용 — 머지는 인간 유지.
 */
export function MergeBacklog({ branches }: { branches: UnmergedPlanBranch[] | undefined }) {
  if (!branches || branches.length === 0) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cr-repo-chip">
            <GitMerge size={12} aria-hidden />
            <span>merge 대기</span>
            <span className="cr-merge-count">{branches.length}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div className="cr-usage-tip">
            <div className="cr-usage-tip-title">완주-미머지 plan 브랜치 — 머지는 수동</div>
            <ul className="cr-merge-list">
              {branches.map((b) => (
                <li key={b.branch} className="cr-merge-row">
                  <span className="cr-merge-branch">{b.branch}</span>
                  {b.aheadCount != null && <span className="cr-merge-ahead">+{b.aheadCount}</span>}
                  <span className="cr-usage-tip-muted">{b.subject}</span>
                </li>
              ))}
            </ul>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
