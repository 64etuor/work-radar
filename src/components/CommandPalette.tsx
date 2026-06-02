import "./CommandPalette.css";

import { Blocks, FileText, FolderPlus, GitBranchPlus } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { KindBadge } from "@/components/board/LifeWheelPalette";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV_GROUP_LABELS, navItemsByGroup } from "@/lib/nav";
import { useNavKeymap, useProjects, useSearchSignals, useSkills } from "@/lib/query";
import { skillSearchValue } from "@/lib/skillGrouping";
import { useUIStore } from "@/store";

/**
 * cmdk 명령 팔레트 — 단일 창 네비게이션 진입점 (Cmd+K).
 * 뷰 목록·라벨·단축키는 `@/lib/nav`(정본)에서 가져와 의미 그룹(운영/리뷰/코드/외부)으로
 * 묶어 보여준다 (Phase 18 #4 consolidation). 각 항목은 현재 keymap 단축키를 힌트로 표시한다.
 * 오버레이 backdrop 클릭 또는 Esc로 닫힌다(닫힘은 App 셸이 처리).
 */
export function CommandPalette() {
  const { goTo, goToSkill, goToSignal, setPaletteOpen, setInboxOpen } = useUIStore();
  // Inbox는 뷰가 아니라 에이전트 바 트레이 — 팔레트를 닫고 트레이를 연다(goTo 대체).
  const openInbox = () => {
    setPaletteOpen(false);
    setInboxOpen(true);
  };
  const projects = useProjects();
  const keymap = useNavKeymap();
  // SkillsView와 동일 쿼리(["skills"]) — react-query가 키로 dedup하므로 중복 fetch 없음.
  const skills = useSkills();
  const [query, setQuery] = useState("");
  // 시그널은 전체 이력(아카이브 포함)이 많을 수 있어 클라이언트 필터 대신 서버 FTS를 쓴다.
  // 입력은 useDeferredValue로 디바운스 — 키 입력마다 FTS를 때리지 않는다.
  const deferredQuery = useDeferredValue(query);
  const signalResults = useSearchSignals(deferredQuery);
  const visibleSignals = (signalResults.data ?? []).slice(0, 8);

  const groups = navItemsByGroup();
  const normalizedQuery = query.trim().toLowerCase();
  const showSkills =
    normalizedQuery.includes("skill") ||
    normalizedQuery.includes("스킬") ||
    normalizedQuery.length >= 2;
  const visibleSkills = showSkills
    ? (skills.data ?? [])
        .filter((s) => skillSearchValue(s).toLowerCase().includes(normalizedQuery))
        .slice(0, 8)
    : [];
  const recentActions = recentCommands()
    .map((label) => ({ label, action: actionForRecent(label, goTo, openInbox) }))
    .filter((item): item is { label: string; action: () => void } => !!item.action);

  const runCommand = (label: string, action: () => void) => {
    rememberRecentCommand(label);
    action();
  };

  return (
    <div className="cmdk-overlay" onPointerDown={() => setPaletteOpen(false)}>
      <div className="cmdk-panel" onPointerDown={(e) => e.stopPropagation()}>
        <Command loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="명령 검색 — 뷰, 설정, 프로젝트…"
            autoFocus
          />
          <CommandList>
            <CommandEmpty>일치하는 항목이 없습니다.</CommandEmpty>

            {groups.map(({ group, items }) => (
              <CommandGroup key={group} heading={NAV_GROUP_LABELS[group]}>
                {items.map((item) => {
                  const Icon = item.icon;
                  const sc = keymap.data?.[item.view]?.trim();
                  return (
                    <CommandItem
                      key={item.view}
                      value={item.search}
                      onSelect={() =>
                        runCommand(item.label, () =>
                          goTo(item.view, item.view === "settings" ? "open" : undefined),
                        )
                      }
                    >
                      <Icon className="text-wr-subtle size-4" />
                      <span>{item.label}</span>
                      {sc && <CommandShortcut>{sc}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}

            <CommandGroup heading="추천 액션">
              <CommandItem
                value="inbox unread alert 알림"
                onSelect={() => runCommand("Inbox", openInbox)}
              >
                <Blocks className="text-wr-subtle size-4" />
                <span>Inbox 확인</span>
                <CommandShortcut>운영</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="pr radar refresh review"
                onSelect={() => runCommand("PR Radar", () => goTo("radar"))}
              >
                <GitBranchPlus className="text-wr-subtle size-4" />
                <span>PR Radar 보기</span>
                <CommandShortcut>context</CommandShortcut>
              </CommandItem>
            </CommandGroup>

            {recentActions.length > 0 && (
              <CommandGroup heading="최근 실행">
                {recentActions.map(({ label, action }) => (
                  <CommandItem
                    key={label}
                    value={`recent ${label}`}
                    onSelect={() => runCommand(label, action)}
                  >
                    <FileText className="text-wr-subtle size-4" />
                    <span>{label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {visibleSkills.length > 0 && (
              <CommandGroup heading="스킬 검색 결과">
                {visibleSkills.map((s) => {
                  const isInApp = s.kind === "in_app_prompt";
                  return (
                    <CommandItem
                      key={s.id}
                      value={skillSearchValue(s)}
                      // 선택 = SkillsView로 이동해 보기/편집. 자동 실행 없음(INVARIANT #1/#5).
                      onSelect={() => runCommand(`Skill: ${s.name}`, () => goToSkill(s.id))}
                    >
                      {isInApp ? (
                        <Blocks className="text-wr-subtle size-4" />
                      ) : (
                        <FileText className="text-wr-subtle size-4" />
                      )}
                      <span>{s.name}</span>
                      {isInApp && s.binding && (
                        <span className="text-wr-subtle ml-2 font-mono text-xs">{s.binding}</span>
                      )}
                      {isInApp && !s.enabled && <CommandShortcut>꺼짐</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {visibleSignals.length > 0 && (
              <CommandGroup heading="시그널 검색 결과">
                {visibleSignals.map((s) => (
                  <CommandItem
                    key={s.id}
                    // value에 입력 쿼리를 넣어 cmdk 클라이언트 필터가 백엔드 FTS 히트를 버리지
                    // 않게 한다(본문 매칭이면 제목엔 쿼리가 없을 수 있음). 선택 = 보드로 이동+
                    // 포커스(선택). 자동 실행 없음(INVARIANT #1).
                    value={`signal ${query} ${s.title} ${s.id}`}
                    onSelect={() => runCommand(`Signal: ${s.title}`, () => goToSignal(s.id))}
                  >
                    <FileText className="text-wr-subtle size-4" />
                    <span className="truncate">{s.title}</span>
                    {s.kind && (
                      <KindBadge
                        kind={s.kind}
                        className="ml-2 h-4 px-1.5 py-0 text-[10px] leading-none"
                      />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="추가">
              <CommandItem
                value="add project 프로젝트 추가"
                onSelect={() => runCommand("프로젝트 추가", () => goTo("settings", "add_project"))}
              >
                <FolderPlus className="text-wr-subtle size-4" />
                <span>프로젝트 추가</span>
              </CommandItem>
              <CommandItem
                value="add repo 레포 추가"
                onSelect={() => runCommand("레포 추가", () => goTo("settings", "add_repo"))}
              >
                <GitBranchPlus className="text-wr-subtle size-4" />
                <span>레포 추가</span>
              </CommandItem>
            </CommandGroup>

            {!!projects.data?.length && (
              <CommandGroup heading="프로젝트">
                {projects.data.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`project ${p.name} ${p.kind}`}
                    onSelect={() =>
                      runCommand(`Project: ${p.name}`, () => goTo("settings", "open"))
                    }
                  >
                    <span>{p.name}</span>
                    <KindBadge
                      kind={p.kind}
                      className="ml-2 h-4 px-1.5 py-0 text-[10px] leading-none"
                    />
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

const RECENT_COMMANDS_KEY = "wr-cmdk-recent";

function recentCommands(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_COMMANDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

function actionForRecent(
  label: string,
  goTo: ReturnType<typeof useUIStore.getState>["goTo"],
  openInbox: () => void,
): (() => void) | null {
  if (label === "Inbox") return openInbox;
  if (label === "PR Radar") return () => goTo("radar");
  if (label === "프로젝트 추가") return () => goTo("settings", "add_project");
  if (label === "레포 추가") return () => goTo("settings", "add_repo");
  if (label.startsWith("Skill: ")) return () => goTo("skills");
  if (label.startsWith("Signal: ")) return () => goTo("board");
  if (label.startsWith("Project: ")) return () => goTo("settings", "open");
  const match = Object.values(navItemsByGroup())
    .flatMap((group) => group.items)
    .find((item) => item.label === label);
  return match ? () => goTo(match.view, match.view === "settings" ? "open" : undefined) : null;
}

function rememberRecentCommand(label: string) {
  try {
    const next = [label, ...recentCommands().filter((x) => x !== label)].slice(0, 5);
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    /* ignore storage failures */
  }
}
