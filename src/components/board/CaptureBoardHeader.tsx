import { Target } from "lucide-react";

import type { Objective, OkrCheckIn } from "@/bindings";
import { SprintTimer } from "@/components/SprintTimer";
import { objectiveProgressRatio, uncheckedKrCount, weekStartMonday } from "@/lib/okr";
import { useUIStore } from "@/store";

/**
 * 헤더 우측 OKR 미니 스트립 — 분기 진행률 + 이번 주 남은 체크인(Lattice식 "일하는 곳의 넛지").
 * 표시 전용 + 클릭 = Mission 뷰 이동뿐(INVARIANT #1). 활성 Objective가 없으면 렌더 안 함.
 * 데이터는 CaptureBoard가 내려준다(ownership 가드: leaf는 쿼리 오케스트레이션 금지).
 */
function OkrStrip({
  quarter,
  objectives,
  checkIns,
}: {
  quarter: string;
  objectives: Objective[];
  checkIns: OkrCheckIn[];
}) {
  const goTo = useUIStore((s) => s.goTo);

  const active = objectives.filter((o) => o.status === "active");
  if (active.length === 0) return null;

  const progress =
    active.reduce((sum, o) => sum + objectiveProgressRatio(o.keyResults), 0) / active.length;
  const pending = uncheckedKrCount(active, checkIns, weekStartMonday());

  return (
    <button
      type="button"
      className="cb-okr-strip"
      // 클릭 후 포커스 잔류 방지(툴바 패턴) — 잔류하면 전역 Enter가 브레인덤프 대신 재발동.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => goTo("mission")}
      title={`${quarter} Objective ${active.length}개 · 진행률 ${Math.round(progress * 100)}%${
        pending > 0 ? ` · 이번 주 체크인 ${pending}개 남음` : ""
      } — Mission 뷰로`}
    >
      <Target aria-hidden className="cb-okr-icon" size={12} strokeWidth={1.8} />
      <span className="cb-okr-q">{quarter.slice(-2)}</span>
      <span className="cb-okr-pct">{Math.round(progress * 100)}%</span>
      {pending > 0 && <span className="cb-okr-pending">체크인 {pending}</span>}
    </button>
  );
}

export function CaptureBoardHeader({
  okrQuarter,
  okrObjectives,
  okrCheckIns,
}: {
  okrQuarter: string;
  okrObjectives: Objective[];
  okrCheckIns: OkrCheckIn[];
}) {
  return (
    <div className="cb-head">
      <span className="mark">◎ Work Radar / Capture</span>
      <div className="cb-head-center">
        <SprintTimer />
      </div>
      <div className="cb-head-right">
        <OkrStrip quarter={okrQuarter} objectives={okrObjectives} checkIns={okrCheckIns} />
      </div>
    </div>
  );
}
