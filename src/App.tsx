import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { RootPalette } from "@/components/RootPalette";

/**
 * Raycast 모델: 하나의 창 = 하나의 팔레트.
 * 전역 핫키(Alt+Space, Rust 측 처리)로 토글되고, Esc로 숨긴다.
 */
export default function App() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-wr-bg">
      <RootPalette />
    </div>
  );
}
