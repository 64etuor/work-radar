import { useState } from "react";

/** 패널 접힘 상태를 localStorage에 유지하는 토글 훅(레이아웃 선호 보존). */
export function useStickyToggle(key: string): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* private mode 등 — 무시 */
    }
  };
  return [on, set];
}
