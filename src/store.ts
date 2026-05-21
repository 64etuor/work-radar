import { create } from "zustand";

/** 어느 표면을 보여줄지 (단일 창 내 토글). */
export type View =
  | "board"
  | "settings"
  | "radar"
  | "worktree"
  | "mismatch"
  | "jobs";
/** 설정 진입 의도 (cmdk 팔레트 항목 → Settings 뷰 포커스). */
export type SettingsIntent = "open" | "add_project" | "add_repo";

/** 경량 UI 상태 (Zustand). 데이터는 TanStack Query가, 화면/팔레트 상태는 여기서. */
interface UIState {
  query: string;
  setQuery: (query: string) => void;
  /** 현재 표면. */
  view: View;
  /** cmdk 명령 팔레트 오버레이 열림 여부. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Settings 뷰 진입 시 포커스 의도 (한 번 소비). */
  settingsIntent: SettingsIntent;
  /** 보드↔설정 이동 (팔레트는 닫는다). */
  goTo: (view: View, intent?: SettingsIntent) => void;
}

export const useUIStore = create<UIState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  view: "board",
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  settingsIntent: "open",
  goTo: (view, intent = "open") =>
    set({ view, settingsIntent: intent, paletteOpen: false }),
}));
