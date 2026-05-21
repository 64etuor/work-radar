import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CaptureBoard } from "@/components/CaptureBoard";

/**
 * Raycast 모델: 하나의 창 = 하나의 팔레트.
 * 전역 핫키(Alt+Space, Rust 측 처리)로 토글되고, Esc로 숨긴다.
 */
export default function App() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 카드 메뉴가 열려 있으면 그 닫힘을 CaptureBoard에 맡기고 창은 유지한다.
        // (둘 다 window에서 Esc를 듣기 때문에 중복 동작 방지.)
        if (document.querySelector(".cb-card-menu")) return;
        void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-wr-bg">
      <CaptureBoard />
    </div>
  );
}
