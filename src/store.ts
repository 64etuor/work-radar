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
  /** 미분류 전체 AI 제안 잡 id — 전역 패널이 어느 뷰에서나 유지되도록 App shell이 소유한다. */
  enrichAllRunId: string | null;
  setEnrichAllRunId: (runId: string | null) => void;
  /** 전체 제안 생성 중 여부 — 보드 버튼과 전역 패널이 같은 진행 상태를 공유한다. */
  enrichAllGenerating: boolean;
  setEnrichAllGenerating: (running: boolean) => void;
  /** Settings 뷰 진입 시 포커스 의도 (한 번 소비). */
  settingsIntent: SettingsIntent;
  /** 팔레트에서 고른 스킬 id (한 번 소비). SkillsView가 읽어 선택 후 clear. */
  pendingSkillId: string | null;
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
}

export const useUIStore = create<UIState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  view: "board",
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  calendarOpen: false,
  setCalendarOpen: (calendarOpen) => set({ calendarOpen }),
  enrichAllRunId: null,
  setEnrichAllRunId: (enrichAllRunId) => set({ enrichAllRunId }),
  enrichAllGenerating: false,
  setEnrichAllGenerating: (enrichAllGenerating) => set({ enrichAllGenerating }),
  settingsIntent: "open",
  pendingSkillId: null,
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
}));
