import { create } from "zustand";

/** 어느 표면을 보여줄지 (단일 창 내 토글). */
export type View =
  | "board"
  | "today"
  | "inbox"
  | "weekly"
  | "retro"
  | "routines"
  | "settings"
  | "radar"
  | "worktree"
  | "jobs"
  | "skills";
/** 설정 진입 의도 (cmdk 팔레트 항목 → Settings 뷰 포커스). */
export type SettingsIntent = "open" | "add_project" | "add_repo";

/** 앱 테마. localStorage에 유지(부팅 시 복원). */
export type Theme = "light" | "dark";
const THEME_KEY = "wr-theme";
function initialTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * 본문 폰트 프리셋. `--font-sans` 토큰을 덮어쓰는 단일 전역 선택.
 * 타이틀(`--font-display`)·모노(`--font-mono`)는 변경하지 않는다(시각 디자인 정본 유지).
 * 표시 전용 — 결정 레일과 무관.
 */
export type FontPreset = "system" | "cohere" | "inter" | "pretendard" | "suit" | "jbm-hangul";
const FONT_KEY = "wr-font";
const DEFAULT_FONT: FontPreset = "cohere";
function isFontPreset(value: string | null): value is FontPreset {
  return (
    value === "system" ||
    value === "cohere" ||
    value === "inter" ||
    value === "pretendard" ||
    value === "suit" ||
    value === "jbm-hangul"
  );
}
function initialFont(): FontPreset {
  try {
    const raw = localStorage.getItem(FONT_KEY);
    return isFontPreset(raw) ? raw : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

// 이전엔 acked run ids를 localStorage에 보관했다(cap=200, silently trim). 캐시 클리어/리인스톨/
// cap 초과 시 잡이 바에 재출현하는 회귀가 있어 `agent_runs.acked_at` 컬럼(0036 마이그레이션)로
// 옮겼다. 잔존 키는 부팅 시 1회 정리(다음 릴리즈에서 제거 가능).
try {
  localStorage.removeItem("wr-agent-bar-acked");
} catch {
  /* private mode 등 — 무시 */
}

/** 경량 UI 상태 (Zustand). 데이터는 TanStack Query가, 화면/팔레트 상태는 여기서. */
interface UIState {
  query: string;
  setQuery: (query: string) => void;
  /** 현재 표면. */
  view: View;
  /** cmdk 명령 팔레트 오버레이 열림 여부. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** 캘린더 드로어 열림(전역) — 에이전트 바 우측 아이콘/단축키로 토글, 어느 뷰에서나. 표시 전용. */
  calendarOpen: boolean;
  setCalendarOpen: (open: boolean) => void;
  /** 전역 에이전트 결과 모달 — 현재 열린 agent_runs row id (없으면 null).
   * 에이전트 바 박스를 클릭하면 set. 모달이 닫히면 null + 종료 잡이면 ack.
   * 자동 오픈 금지(INVARIANT #1 표시 전용 — 사람이 클릭해야 결과를 본다). */
  openAgentRunId: string | null;
  setOpenAgentRunId: (runId: string | null) => void;
  /** Settings 뷰 진입 시 포커스 의도 (한 번 소비). */
  settingsIntent: SettingsIntent;
  /** 팔레트에서 고른 스킬 id (한 번 소비). SkillsView가 읽어 선택 후 clear. */
  pendingSkillId: string | null;
  /** 팔레트 검색에서 고른 시그널 id (한 번 소비). CaptureBoard가 읽어 선택 후 clear. */
  pendingSignalId: string | null;
  /** 앱 테마(light/dark). 표시 전용 — 결정 레일과 무관. */
  theme: Theme;
  /** 테마 토글(+ localStorage 영속). */
  toggleTheme: () => void;
  /** 테마 명시 설정(+ localStorage 영속) — Appearance 라디오 UI용. */
  setTheme: (theme: Theme) => void;
  /** 본문 폰트 프리셋. */
  font: FontPreset;
  /** 폰트 설정(+ localStorage 영속). */
  setFont: (font: FontPreset) => void;
  /** 보드↔설정 이동 (팔레트는 닫는다). */
  goTo: (view: View, intent?: SettingsIntent) => void;
  /** 팔레트에서 스킬 선택 → SkillsView로 이동하며 그 스킬을 선택(보기/편집). 자동 실행 아님. */
  goToSkill: (skillId: string) => void;
  /** pendingSkillId 소비 후 clear (한 번만 적용). */
  clearPendingSkill: () => void;
  /** 팔레트 검색에서 시그널 선택 → 보드로 이동하며 그 카드를 포커스(선택). 자동 실행 아님. */
  goToSignal: (signalId: string) => void;
  /** pendingSignalId 소비 후 clear (한 번만 적용). */
  clearPendingSignal: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  view: "board",
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  calendarOpen: false,
  setCalendarOpen: (calendarOpen) => set({ calendarOpen }),
  openAgentRunId: null,
  setOpenAgentRunId: (openAgentRunId) => set({ openAgentRunId }),
  settingsIntent: "open",
  pendingSkillId: null,
  pendingSignalId: null,
  theme: initialTheme(),
  toggleTheme: () =>
    set((s) => {
      const theme: Theme = s.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* private mode 등 — 무시 */
      }
      return { theme };
    }),
  setTheme: (theme) =>
    set(() => {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* private mode 등 — 무시 */
      }
      return { theme };
    }),
  font: initialFont(),
  setFont: (font) =>
    set(() => {
      try {
        localStorage.setItem(FONT_KEY, font);
      } catch {
        /* private mode 등 — 무시 */
      }
      return { font };
    }),
  goTo: (view, intent = "open") => set({ view, settingsIntent: intent, paletteOpen: false }),
  goToSkill: (skillId) => set({ view: "skills", pendingSkillId: skillId, paletteOpen: false }),
  clearPendingSkill: () => set({ pendingSkillId: null }),
  goToSignal: (signalId) => set({ view: "board", pendingSignalId: signalId, paletteOpen: false }),
  clearPendingSignal: () => set({ pendingSignalId: null }),
}));
