import { SprintTimer } from "@/components/SprintTimer";

export function CaptureBoardHeader() {
  return (
    <div className="cb-head">
      <span className="mark">◎ Work Radar / Capture</span>
      <div className="cb-head-center">
        <SprintTimer />
      </div>
      <div className="cb-head-right">
        <span className="hint">
          드래그로 분류 · <b>1 2 3 4</b> 사분면 · <b>T</b> Today · 카드 ⋯ 메뉴 ·{" "}
          <b>⌘K</b> 설정/프로젝트
        </span>
      </div>
    </div>
  );
}
