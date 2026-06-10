import {
  Blocks,
  Bot,
  CalendarCheck,
  CalendarRange,
  Gauge,
  GitCompare,
  GitPullRequest,
  LayoutGrid,
  type LucideIcon,
  Repeat,
  Settings,
} from "lucide-react";

import type { KnobDir } from "@/lib/knobGeometry";
import type { View } from "@/store";

/**
 * 네비게이션 정본(Phase 18 #7·#4). CommandPalette·App(per-view 단축키)·Settings keymap 에디터가
 * 이 한 곳을 소비한다 — 뷰 목록/라벨/기본 단축키가 흩어지지 않게(중복 제거).
 *
 * 그룹핑(consolidation): 네비를 의미 단위로 묶는다 — 실제 capability 삭제는 없다(보수적).
 *   운영(operate)  : board / today — 매일 쓰는 결정·실행 표면 (Inbox는 에이전트 바 트레이로 이전 — EXTRA_ACTIONS)
 *   리뷰(review)   : weekly / routines    — 돌아보기·집계
 *   코드(code)     : radar / worktree / jobs      — PR·워크트리·에이전트 잡
 *   외부(connect)  : skills                       — 스킬 레지스트리
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
 * 기본 단축키 = Cmd+숫자(단일 창이라 OS 탭 전환과 충돌 없음 — 사용자 선택). NAV 순서대로 1~9·0.
 * 설정에서 개별 변경 가능(빈 값=끔). 매처는 조합("Cmd+1")과 레거시 단일/체인("1"·"g b") 둘 다 지원.
 * skills는 기본 미할당(Cmd+K 팔레트로 도달) — 숫자가 모자라 남김. calendar는 EXTRA_ACTIONS 참고.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    view: "board",
    label: "캡처 보드",
    search: "board matrix 보드 매트릭스 캡처 아이젠하워",
    icon: LayoutGrid,
    group: "operate",
    defaultShortcut: "Cmd+1",
  },
  {
    view: "today",
    label: "Today (운영)",
    search: "today 오늘 운영 일정 work debt 부채",
    icon: CalendarCheck,
    group: "operate",
    defaultShortcut: "Cmd+2",
  },
  {
    view: "weekly",
    label: "Weekly Review",
    search: "weekly review 주간 회고 집계 처리량 추세 임팩트 보관함 archive 복원",
    icon: CalendarRange,
    group: "review",
    defaultShortcut: "Cmd+4",
  },
  {
    view: "routines",
    label: "루틴 트래킹",
    search: "routine tracking 루틴 트래킹 이행률 streak 연속 히스토리 반복",
    icon: Repeat,
    group: "review",
    defaultShortcut: "Cmd+6",
  },
  {
    view: "radar",
    label: "PR Radar",
    search: "pr radar github 레이더 풀리퀘스트",
    icon: GitPullRequest,
    group: "code",
    defaultShortcut: "Cmd+7",
  },
  {
    view: "worktree",
    label: "Worktree Diff",
    search: "worktree diff branch 워크트리 브랜치 디프 차이",
    icon: GitCompare,
    group: "code",
    defaultShortcut: "Cmd+8",
  },
  {
    view: "jobs",
    label: "Jobs (Agent)",
    search: "jobs agent codex 잡 에이전트 코덱스 자동화",
    icon: Bot,
    group: "code",
    defaultShortcut: "Cmd+9",
  },
  {
    view: "skills",
    label: "스킬 레지스트리",
    search: "skills 스킬 레지스트리 프롬프트 에이전트 claude codex 외부 스킬 편집",
    icon: Blocks,
    group: "connect",
  },
  {
    view: "control-room",
    label: "컨트롤 룸",
    search: "control room 컨트롤룸 거버넌스 boule governance orchestrator 세션 핸드오프 task plan",
    icon: Gauge,
    group: "connect",
  },
  {
    view: "settings",
    label: "설정 열기",
    search: "settings 설정 open keymap 단축키 핫키",
    icon: Settings,
    group: "connect",
    defaultShortcut: "Cmd+,",
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

/** view가 아닌 추가 단축키 액션(설정 키맵 목록에 함께 노출 + App에서 직접 처리). */
export interface ExtraAction {
  /** keymap 키(view와 겹치지 않는 액션 식별자). */
  key: string;
  label: string;
  /** 기본 단축키(없으면 미할당 — 설정 키맵에서 바인딩). */
  defaultShortcut?: string;
}

/** 캘린더·Inbox 등 view-비귀속 단축키. App의 onAction이 key로 분기해 처리한다. */
export const EXTRA_ACTIONS: ExtraAction[] = [
  { key: "calendar", label: "캘린더 열기/닫기", defaultShortcut: "Cmd+Shift+C" },
  // Inbox 트레이 토글 — 기본 단축키 없음(⌘⇧I는 WebView 개발자도구 바인딩이라 충돌 회피; 설정에서 바인딩).
  { key: "inbox", label: "Inbox 열기/닫기" },
];

/** 기본 keymap(action → shortcut). 저장된 keymap이 없을 때 폴백. view + EXTRA_ACTIONS. */
export function defaultKeymap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const n of NAV_ITEMS) if (n.defaultShortcut) m[n.view] = n.defaultShortcut;
  for (const a of EXTRA_ACTIONS) if (a.defaultShortcut) m[a.key] = a.defaultShortcut;
  // 조이스틱: 좌우는 인접 뷰 nav(기존 슬라이드 재사용), 상하는 기본 비활성(빈값).
  m.knob_left = "Cmd+Left";
  m.knob_right = "Cmd+Right";
  m.knob_up = "";
  m.knob_down = "";
  m[KNOB_TRIGGER_KEY] = KNOB_TRIGGER_DEFAULT;
  return m;
}

/** 조이스틱 방향 메타 — 설정 행/가이드 글리프/keymap 키를 한 곳에서. */
export const KNOB_DIRECTIONS: { dir: KnobDir; key: string; label: string; glyph: string }[] = [
  { dir: "up", key: "knob_up", label: "조이스틱 ↑", glyph: "↑" },
  { dir: "down", key: "knob_down", label: "조이스틱 ↓", glyph: "↓" },
  { dir: "left", key: "knob_left", label: "조이스틱 ←", glyph: "←" },
  { dir: "right", key: "knob_right", label: "조이스틱 →", glyph: "→" },
];

/** knob 호출(트리거) 모디파이어 spec을 담는 예약 keymap 키 + 기본값. */
export const KNOB_TRIGGER_KEY = "knob_trigger";
export const KNOB_TRIGGER_DEFAULT = "Cmd";

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

/** 설정된 단축키 한 줄(치트시트용). */
export interface ShortcutHint {
  key: string;
  label: string;
  spec: string;
}

/**
 * keymap에서 **설정된(비어있지 않은)** nav/액션 단축키만 추린다(치트시트용). 순수 함수.
 * 순서 = NAV_ITEMS → EXTRA_ACTIONS(설정 키맵 에디터와 동일 목록). knob 방향/트리거는 제외
 * (조이스틱 자체 설정이라 단축키 치트시트 대상 아님).
 */
export function buildShortcutHints(keymap: Record<string, string> | undefined): ShortcutHint[] {
  if (!keymap) return [];
  const rows: { key: string; label: string }[] = [
    ...NAV_ITEMS.map((n) => ({ key: n.view as string, label: n.label })),
    ...EXTRA_ACTIONS.map((a) => ({ key: a.key, label: a.label })),
  ];
  return rows
    .map((r) => ({ ...r, spec: (keymap[r.key] ?? "").trim() }))
    .filter((r) => r.spec.length > 0);
}

/** 슬라이드 전환 방향(App의 navigateView가 받는 motion). NAV 순서 기준. */
export type ViewMotion = "forward" | "back" | "neutral";

/**
 * NAV_ITEMS 순서 기준으로 from→to 슬라이드 방향을 정한다(페이지 메뉴 클릭 전환용). 순수 함수.
 * to가 from보다 뒤(인덱스 큼)면 forward, 앞이면 back, 같거나 미발견이면 neutral(슬라이드 없음).
 * adjacentView의 wrap과 달리 여기선 인접 여부와 무관하게 순서만으로 방향을 정한다.
 */
export function viewMotionBetween(from: View, to: View): ViewMotion {
  const fi = NAV_ITEMS.findIndex((n) => n.view === from);
  const ti = NAV_ITEMS.findIndex((n) => n.view === to);
  if (fi === -1 || ti === -1 || fi === ti) return "neutral";
  return ti > fi ? "forward" : "back";
}
