import { FolderGit2 } from "lucide-react";

import type { CoveredRepo } from "@/bindings";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

/**
 * 프로젝트 바 우측 — 이 스냅샷이 실제로 접은(covered) 레포 표시.
 * 프로젝트는 레포를 여러 개 가질 수 있지만 스냅샷은 첫 enabled 로컬 레포 하나만 접는다 —
 * 멀티레포면 "+N" 마커로 미포함 레포 존재를 드러낸다(조용히 숨기지 않는다).
 */
export function RepoCoverage({ covered }: { covered: CoveredRepo | null | undefined }) {
  if (!covered) return null;
  const extra = Math.max(0, covered.enabledLocalTotal - 1);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cr-repo-chip">
            <FolderGit2 size={12} aria-hidden />
            <span className="cr-repo-name">{covered.name}</span>
            {extra > 0 && <span className="cr-repo-extra">+{extra}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div className="cr-usage-tip">
            <div className="cr-usage-tip-title">집계 대상 레포</div>
            <div className="cr-usage-tip-muted">{covered.localPath}</div>
            {extra > 0 && (
              <div className="cr-usage-tip-muted">
                이 프로젝트의 다른 로컬 레포 {extra}개는 이 보드에 집계되지 않습니다.
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
