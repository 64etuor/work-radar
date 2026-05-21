import { useState } from "react";
import {
  Bot,
  FolderPlus,
  GitBranchPlus,
  GitCompare,
  GitPullRequest,
  LayoutGrid,
  Settings,
  Unlink,
} from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandShortcut,
  CommandList,
} from "@/components/ui/command";
import { useProjects } from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * cmdk 명령 팔레트 — 단일 창 네비게이션 진입점 (Cmd+K).
 * 보드↔설정 이동 + Add Project / Add Repo. (사용자 선택: cmdk 팔레트 재사용.)
 * 오버레이 backdrop 클릭 또는 Esc로 닫힌다(닫힘은 App 셸이 처리).
 */
export function CommandPalette() {
  const { goTo, setPaletteOpen } = useUIStore();
  const projects = useProjects();
  const [query, setQuery] = useState("");

  return (
    <div className="cmdk-overlay" onPointerDown={() => setPaletteOpen(false)}>
      <div className="cmdk-panel" onPointerDown={(e) => e.stopPropagation()}>
        <Command loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="명령 검색 — 설정, 프로젝트…"
            autoFocus
          />
          <CommandList>
            <CommandEmpty>일치하는 항목이 없습니다.</CommandEmpty>

            <CommandGroup heading="네비게이션">
              <CommandItem value="board matrix 보드 매트릭스" onSelect={() => goTo("board")}>
                <LayoutGrid className="size-4 text-wr-subtle" />
                <span>캡처 보드로</span>
              </CommandItem>
              <CommandItem
                value="pr radar github 레이더 풀리퀘스트"
                onSelect={() => goTo("radar")}
              >
                <GitPullRequest className="size-4 text-wr-subtle" />
                <span>PR Radar로</span>
              </CommandItem>
              <CommandItem
                value="worktree diff branch 워크트리 브랜치 디프 차이"
                onSelect={() => goTo("worktree")}
              >
                <GitCompare className="size-4 text-wr-subtle" />
                <span>Worktree Diff로</span>
              </CommandItem>
              <CommandItem
                value="mismatch drift notion pr 미스매치 드리프트 노션 동기화"
                onSelect={() => goTo("mismatch")}
              >
                <Unlink className="size-4 text-wr-subtle" />
                <span>Status Mismatch로</span>
              </CommandItem>
              <CommandItem
                value="jobs agent codex 잡 에이전트 코덱스 자동화"
                onSelect={() => goTo("jobs")}
              >
                <Bot className="size-4 text-wr-subtle" />
                <span>Jobs (Agent)로</span>
              </CommandItem>
              <CommandItem
                value="settings 설정 open"
                onSelect={() => goTo("settings", "open")}
              >
                <Settings className="size-4 text-wr-subtle" />
                <span>설정 열기</span>
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="add project 프로젝트 추가"
                onSelect={() => goTo("settings", "add_project")}
              >
                <FolderPlus className="size-4 text-wr-subtle" />
                <span>프로젝트 추가</span>
              </CommandItem>
              <CommandItem
                value="add repo 레포 추가"
                onSelect={() => goTo("settings", "add_repo")}
              >
                <GitBranchPlus className="size-4 text-wr-subtle" />
                <span>레포 추가</span>
              </CommandItem>
            </CommandGroup>

            {!!projects.data?.length && (
              <CommandGroup heading="프로젝트">
                {projects.data.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`project ${p.name} ${p.kind}`}
                    onSelect={() => goTo("settings", "open")}
                  >
                    <span>{p.name}</span>
                    <span className="ml-2 font-mono text-xs text-wr-subtle">
                      {p.kind === "personal" ? "개인" : "업무"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
