import { SprintTimer } from "@/components/SprintTimer";

export function CaptureBoardHeader() {
  return (
    <div className="cb-head">
      <span className="mark">◎ Work Radar / Capture</span>
      <div className="cb-head-center">
        <SprintTimer />
      </div>
      <div className="cb-head-right" aria-hidden />
    </div>
  );
}
