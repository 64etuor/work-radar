import { create } from "zustand";

/** 루트 팔레트의 경량 UI 상태 (Zustand). 데이터는 TanStack Query가, 상태는 여기서. */
interface UIState {
  query: string;
  setQuery: (query: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));
