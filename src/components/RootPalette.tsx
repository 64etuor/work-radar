import {
  FolderPlus,
  GitPullRequest,
  LayoutGrid,
  Radar,
  Settings,
  SquarePen,
} from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useProjects } from "@/lib/query";
import { useUIStore } from "@/store";

/** 루트 검색 + 컨텍스트 액션 (Raycast root search). */
export function RootPalette() {
  const { query, setQuery } = useUIStore();
  const projects = useProjects();
  const projectCount = projects.data?.length ?? 0;

  return (
    <Command loop className="flex-1">
      {/* 헤더 = 창 드래그 영역 (decoration 없는 창 이동) */}
      <header
        data-tauri-drag-region
        className="flex items-center gap-2 px-4 pb-1 pt-3 text-wr-subtle"
      >
        <Radar className="size-3.5" />
        <span className="font-display text-xs font-medium tracking-tight">
          Work Radar
        </span>
      </header>

      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="검색 — 캡처, 매트릭스, PR Radar…"
        autoFocus
      />

      <CommandList>
        <CommandEmpty>일치하는 항목이 없습니다.</CommandEmpty>

        <CommandGroup heading="프로젝트">
          {projects.isLoading && (
            <CommandItem disabled value="loading">
              불러오는 중…
            </CommandItem>
          )}
          {projects.isError && (
            <CommandItem disabled value="error">
              <span className="text-q1">
                프로젝트 로드 실패: {String(projects.error)}
              </span>
            </CommandItem>
          )}
          {projects.data && projectCount === 0 && (
            <CommandItem disabled value="no-projects empty">
              <FolderPlus className="size-4 text-wr-subtle" />
              <span className="text-wr-muted">
                아직 프로젝트가 없습니다 — 개인/업무 프로젝트를 추가해 시작하세요
              </span>
            </CommandItem>
          )}
          {projects.data?.map((p) => (
            <CommandItem key={p.id} value={p.name}>
              <span>{p.name}</span>
              <span className="ml-2 font-mono text-xs text-wr-subtle">
                {p.kind}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="뷰 · 곧 제공">
          <CommandItem disabled value="capture">
            <SquarePen className="size-4" />
            <span>캡처 (Braindump)</span>
            <CommandShortcut>⌥Space</CommandShortcut>
          </CommandItem>
          <CommandItem disabled value="matrix">
            <LayoutGrid className="size-4" />
            <span>아이젠하워 매트릭스</span>
            <CommandShortcut>⌘1</CommandShortcut>
          </CommandItem>
          <CommandItem disabled value="pr-radar">
            <GitPullRequest className="size-4" />
            <span>PR Radar</span>
            <CommandShortcut>⌘2</CommandShortcut>
          </CommandItem>
          <CommandItem disabled value="settings">
            <Settings className="size-4" />
            <span>설정</span>
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>

      <footer className="flex items-center justify-between border-t border-wr-border px-4 py-2 text-[11px] text-wr-subtle">
        <span className="flex items-center gap-1.5">
          <span
            className={
              projects.isError
                ? "size-1.5 rounded-full bg-q1"
                : "size-1.5 rounded-full bg-q2"
            }
          />
          <span className="font-mono">{projectCount}</span> 프로젝트
        </span>
        <span className="flex items-center gap-3 font-mono">
          <span>⌥Space 토글</span>
          <span>Esc 숨기기</span>
        </span>
      </footer>
    </Command>
  );
}
