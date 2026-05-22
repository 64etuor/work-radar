import { useState } from "react";
import {
  Bot,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  History,
  FolderPlus,
  GitBranchPlus,
  GitCompare,
  GitPullRequest,
  LayoutGrid,
  MessageCircle,
  Repeat,
  Settings,
  Wrench,
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
                value="today 오늘 운영 일정 work debt 부채"
                onSelect={() => goTo("today")}
              >
                <CalendarCheck className="size-4 text-wr-subtle" />
                <span>Today (운영)로</span>
              </CommandItem>
              <CommandItem
                value="timeline 타임라인 시간축 아젠다 일정"
                onSelect={() => goTo("timeline")}
              >
                <CalendarClock className="size-4 text-wr-subtle" />
                <span>Timeline으로</span>
              </CommandItem>
              <CommandItem
                value="weekly review 주간 회고 집계 처리량 추세"
                onSelect={() => goTo("weekly")}
              >
                <CalendarRange className="size-4 text-wr-subtle" />
                <span>Weekly Review로</span>
              </CommandItem>
              <CommandItem
                value="retro 회고 완료 임팩트 보관함 archive 복원 regret"
                onSelect={() => goTo("retro")}
              >
                <History className="size-4 text-wr-subtle" />
                <span>회고 / 보관함으로</span>
              </CommandItem>
              <CommandItem
                value="routine tracking 루틴 트래킹 이행률 streak 연속 히스토리 반복"
                onSelect={() => goTo("routines")}
              >
                <Repeat className="size-4 text-wr-subtle" />
                <span>루틴 트래킹으로</span>
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
                value="jobs agent codex 잡 에이전트 코덱스 자동화"
                onSelect={() => goTo("jobs")}
              >
                <Bot className="size-4 text-wr-subtle" />
                <span>Jobs (Agent)로</span>
              </CommandItem>
              <CommandItem
                value="hermes 헤르메스 메신저 브리지 텔레그램 telegram bot 외부 에이전트 채팅"
                onSelect={() => goTo("hermes")}
              >
                <MessageCircle className="size-4 text-wr-subtle" />
                <span>Hermes (메신저 브리지)로</span>
              </CommandItem>
              <CommandItem
                value="skills 스킬 레지스트리 프롬프트 에이전트 claude codex 외부 스킬 편집"
                onSelect={() => goTo("skills")}
              >
                <Wrench className="size-4 text-wr-subtle" />
                <span>스킬 레지스트리로</span>
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
