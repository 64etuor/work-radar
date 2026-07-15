import { RefreshCw, Trash2, Waypoints } from "lucide-react";

import type { Project } from "@/bindings";
import { KindBadge } from "@/components/board/LifeWheelPalette";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ControlRoomBrief } from "@/lib/worktreeReview";

const PROJECT_ALL = "__all__";

type ToggleControl = {
  enabled: boolean;
  active: boolean;
  onToggle: () => void;
};

export function WorktreeHeader({
  projects,
  projectFilter,
  brief,
  graph,
  cleanup,
  worktreesFetching,
  onProjectFilterChange,
  onRefresh,
}: {
  projects: Project[];
  projectFilter: string | null;
  brief: ControlRoomBrief;
  graph: ToggleControl;
  cleanup: ToggleControl;
  worktreesFetching: boolean;
  onProjectFilterChange: (projectId: string | null) => void;
  onRefresh: () => void;
}) {
  return (
    <header className="wt-head" data-tauri-drag-region>
      <div className="wt-head-copy">
        <span className="wt-head-kicker typo-mono-heading">CODE / WORKSPACE REVIEW</span>
        <h1>Worktree Control Room</h1>
        <p className="typo-body-sm">작업공간의 변경 근거를 읽고, 안전한 다음 행동을 결정합니다.</p>
      </div>
      <ul className="wt-brief" aria-label="Worktree portfolio summary">
        <BriefFact label="Repositories" value={brief.repositories} />
        <BriefFact label="Worktrees" value={brief.worktrees} />
        <BriefFact label="Active now" value={brief.active} />
        <BriefFact label="Attention" value={brief.attention} tone="attention" />
      </ul>
      <div className="wt-head-controls">
        <span className="wt-live-status typo-mono-sm" role="status">
          <i aria-hidden="true" />
          {worktreesFetching ? "Refreshing" : "Live · 8s"}
        </span>
        <Select
          value={projectFilter ?? PROJECT_ALL}
          onValueChange={(v) => onProjectFilterChange(v === PROJECT_ALL ? null : v)}
        >
          <SelectTrigger className="w-auto min-w-[150px] text-[12px]" aria-label="프로젝트 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROJECT_ALL}>전체 프로젝트</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="inline-flex items-center gap-1.5">
                  {p.name}
                  <KindBadge kind={p.kind} className="h-4 px-1.5 py-0 text-[10px] leading-none" />
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="wt-head-action" aria-label="Evidence">
          <span className="typo-label-xs">Evidence</span>
          <Button
            variant={graph.active ? "default" : "outline"}
            size="pill-sm"
            className="gap-1.5"
            onClick={graph.onToggle}
            disabled={!graph.enabled}
            title={graph.enabled ? "커밋 그래프 보기" : "worktree 선택 필요"}
          >
            <Waypoints className="size-3.5" />
            Graph
          </Button>
        </div>
        <div className="wt-head-action" aria-label="Maintenance">
          <span className="typo-label-xs">Maintenance</span>
          <Button
            variant={cleanup.active ? "default" : "outline"}
            size="pill-sm"
            className="gap-1.5"
            onClick={cleanup.onToggle}
            disabled={!cleanup.enabled}
            title="브랜치/워크트리 정리"
          >
            <Trash2 className="size-3.5" />
            정리
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-wr-muted size-8 shrink-0 rounded-full p-0"
          onClick={onRefresh}
          title={worktreesFetching ? "새로고침 중" : "새로고침"}
        >
          <RefreshCw className={cn("size-3.5", worktreesFetching && "wt-spin")} />
        </Button>
      </div>
    </header>
  );
}

function BriefFact({ label, value, tone }: { label: string; value: number; tone?: "attention" }) {
  return (
    <li className={cn("wt-brief-fact", tone && `wt-brief-${tone}`)}>
      <span className="typo-label-xs">{label}</span>
      <strong>{value}</strong>
    </li>
  );
}
