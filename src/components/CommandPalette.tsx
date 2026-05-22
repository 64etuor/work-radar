import { useState } from "react";
import { FolderPlus, GitBranchPlus } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandShortcut,
  CommandList,
} from "@/components/ui/command";
import { useNavKeymap, useProjects } from "@/lib/query";
import { NAV_GROUP_LABELS, navItemsByGroup } from "@/lib/nav";
import { useUIStore } from "@/store";

/**
 * cmdk 명령 팔레트 — 단일 창 네비게이션 진입점 (Cmd+K).
 * 뷰 목록·라벨·단축키는 `@/lib/nav`(정본)에서 가져와 의미 그룹(운영/리뷰/코드/외부)으로
 * 묶어 보여준다 (Phase 18 #4 consolidation). 각 항목은 현재 keymap 단축키를 힌트로 표시한다.
 * 오버레이 backdrop 클릭 또는 Esc로 닫힌다(닫힘은 App 셸이 처리).
 */
export function CommandPalette() {
  const { goTo, setPaletteOpen } = useUIStore();
  const projects = useProjects();
  const keymap = useNavKeymap();
  const [query, setQuery] = useState("");

  const groups = navItemsByGroup();

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
                        goTo(item.view, item.view === "settings" ? "open" : undefined)
                      }
                    >
                      <Icon className="size-4 text-wr-subtle" />
                      <span>{item.label}</span>
                      {sc && <CommandShortcut>{sc}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}

            <CommandGroup heading="추가">
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
