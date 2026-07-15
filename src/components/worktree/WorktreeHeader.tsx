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

const PROJECT_ALL = "__all__";

type ToggleControl = {
  enabled: boolean;
  active: boolean;
  onToggle: () => void;
};

export function WorktreeHeader({
  projects,
  projectFilter,
  graph,
  cleanup,
  worktreesFetching,
  onProjectFilterChange,
  onRefresh,
}: {
  projects: Project[];
  projectFilter: string | null;
  graph: ToggleControl;
  cleanup: ToggleControl;
  worktreesFetching: boolean;
  onProjectFilterChange: (projectId: string | null) => void;
  onRefresh: () => void;
}) {
  return (
    <header className="wt-head" data-tauri-drag-region>
      <span className="typo-mono-heading">Worktree Diff</span>
      <Select
        value={projectFilter ?? PROJECT_ALL}
        onValueChange={(v) => onProjectFilterChange(v === PROJECT_ALL ? null : v)}
      >
        <SelectTrigger
          className="ml-auto w-auto min-w-[150px] text-[12px]"
          aria-label="프로젝트 필터"
        >
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
      <Button
        variant="outline"
        size="sm"
        className="text-wr-muted size-8 shrink-0 rounded-full p-0"
        onClick={onRefresh}
        title="새로고침"
      >
        <RefreshCw className={cn("size-3.5", worktreesFetching && "wt-spin")} />
      </Button>
    </header>
  );
}
