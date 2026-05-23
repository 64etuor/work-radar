import {
  Blocks,
  Bot,
  CalendarCheck,
  CalendarRange,
  GanttChart,
  GitCompare,
  GitPullRequest,
  History,
  LayoutGrid,
  MessageCircle,
  Repeat,
  Settings,
  type LucideIcon,
} from "lucide-react";

import type { View } from "@/store";

/**
 * 네비게이션 정본(Phase 18 #7·#4). CommandPalette·App(per-view 단축키)·Settings keymap 에디터가
 * 이 한 곳을 소비한다 — 뷰 목록/라벨/기본 단축키가 흩어지지 않게(중복 제거).
 *
 * 그룹핑(consolidation): 네비를 의미 단위로 묶는다 — 실제 capability 삭제는 없다(보수적).
 *   운영(operate)  : board / today / timeline    — 매일 쓰는 결정·실행 표면
 *   리뷰(review)   : weekly / retro / routines    — 돌아보기·집계
 *   코드(code)     : radar / worktree / jobs      — PR·워크트리·에이전트 잡
 *   외부(connect)  : hermes / skills              — 메신저 브리지·스킬 레지스트리
 */
export type NavGroup = "operate" | "review" | "code" | "connect";

export interface NavItem {
  view: View;
  /** 표시 라벨(팔레트/세팅 공용). */
  label: string;
  /** cmdk 검색 매칭 문자열(라벨 + 동의어). */
  search: string;
  icon: LucideIcon;
  group: NavGroup;
  /** 기본 단축키(없으면 단축키 미할당 — Cmd+K 팔레트로만 도달). chord("g b") 또는 단일("1"). */
  defaultShortcut?: string;
}

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  operate: "운영",
  review: "리뷰",
  code: "코드",
  connect: "외부",
};

/**
 * 기본 단축키 = Cmd+K 팔레트와 충돌하지 않는 g-then-key chord(Vim/GitHub식 — 데스크톱 norm)
 * + 자주 쓰는 보드/today/jobs는 chord. 입력 포커스 시 비활성(App.tsx).
 * board는 "g b"처럼 두 키 시퀀스. (Cmd+1..9는 OS/탭 전환과 잦은 충돌이라 chord 채택.)
 */
export const NAV_ITEMS: NavItem[] = [
  {
    view: "board",
    label: "캡처 보드",
    search: "board matrix 보드 매트릭스 캡처 아이젠하워",
    icon: LayoutGrid,
    group: "operate",
    defaultShortcut: "g b",
  },
  {
    view: "today",
    label: "Today (운영)",
    search: "today 오늘 운영 일정 work debt 부채",
    icon: CalendarCheck,
    group: "operate",
    defaultShortcut: "g d",
  },
  {
    view: "timeline",
    label: "Timeline",
    search: "timeline 타임라인 시간축 아젠다 일정",
    icon: GanttChart,
    group: "operate",
    defaultShortcut: "g l",
  },
  {
    view: "weekly",
    label: "Weekly Review",
    search: "weekly review 주간 회고 집계 처리량 추세",
    icon: CalendarRange,
    group: "review",
    defaultShortcut: "g w",
  },
  {
    view: "retro",
    label: "회고 / 보관함",
    search: "retro 회고 완료 임팩트 보관함 archive 복원 regret",
    icon: History,
    group: "review",
    defaultShortcut: "g e",
  },
  {
    view: "routines",
    label: "루틴 트래킹",
    search: "routine tracking 루틴 트래킹 이행률 streak 연속 히스토리 반복",
    icon: Repeat,
    group: "review",
    defaultShortcut: "g u",
  },
  {
    view: "radar",
    label: "PR Radar",
    search: "pr radar github 레이더 풀리퀘스트",
    icon: GitPullRequest,
    group: "code",
    defaultShortcut: "g r",
  },
  {
    view: "worktree",
    label: "Worktree Diff",
    search: "worktree diff branch 워크트리 브랜치 디프 차이",
    icon: GitCompare,
    group: "code",
    defaultShortcut: "g t",
  },
  {
    view: "jobs",
    label: "Jobs (Agent)",
    search: "jobs agent codex 잡 에이전트 코덱스 자동화",
    icon: Bot,
    group: "code",
    defaultShortcut: "g j",
  },
  {
    view: "hermes",
    label: "Hermes (메신저 브리지)",
    search:
      "hermes 헤르메스 메신저 브리지 텔레그램 telegram bot 외부 에이전트 채팅",
    icon: MessageCircle,
    group: "connect",
    defaultShortcut: "g h",
  },
  {
    view: "skills",
    label: "스킬 레지스트리",
    search: "skills 스킬 레지스트리 프롬프트 에이전트 claude codex 외부 스킬 편집",
    icon: Blocks,
    group: "connect",
    defaultShortcut: "g s",
  },
  {
    view: "settings",
    label: "설정 열기",
    search: "settings 설정 open keymap 단축키 핫키",
    icon: Settings,
    group: "connect",
    defaultShortcut: "g ,",
  },
];

/** group → 그 그룹의 NavItem들(NAV_ITEMS 순서 보존). 팔레트/세팅 그룹 렌더에 공용. */
export function navItemsByGroup(): { group: NavGroup; items: NavItem[] }[] {
  const order: NavGroup[] = ["operate", "review", "code", "connect"];
  return order.map((group) => ({
    group,
    items: NAV_ITEMS.filter((n) => n.group === group),
  }));
}

/** view → NavItem 빠른 조회. */
export const NAV_BY_VIEW: Record<View, NavItem> = Object.fromEntries(
  NAV_ITEMS.map((n) => [n.view, n]),
) as Record<View, NavItem>;

/** 기본 keymap(view → shortcut). 저장된 keymap이 없을 때 폴백. */
export function defaultKeymap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const n of NAV_ITEMS) if (n.defaultShortcut) m[n.view] = n.defaultShortcut;
  return m;
}

/**
 * NAV_ITEMS 순서 기반 인접 뷰 계산(Cmd+←/→ 네비). 순수 함수.
 * dir: -1 = 이전, +1 = 다음.
 * 경계 동작은 **wrap**(첫에서 ←는 마지막으로, 마지막에서 →는 첫으로) —
 * plan의 "인접 뷰 전환"이 끊김 없는 순환이라 clamp 대신 wrap 채택.
 * current가 NAV_ITEMS에 없으면 current를 그대로 반환(안전 폴백).
 */
export function adjacentView(current: View, dir: -1 | 1): View {
  const n = NAV_ITEMS.length;
  if (n === 0) return current;
  const idx = NAV_ITEMS.findIndex((item) => item.view === current);
  if (idx === -1) return current;
  const next = (idx + dir + n) % n;
  return NAV_ITEMS[next].view;
}
