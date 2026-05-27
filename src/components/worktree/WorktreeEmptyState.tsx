import { GitCompare } from "lucide-react";

export function WorktreeEmptyState() {
  return (
    <div className="wt-placeholder">
      <GitCompare className="size-5" />
      <span>worktree를 선택하면 변경 파일과 diff를 봅니다.</span>
    </div>
  );
}
