import { Activity, AlertTriangle, Boxes, Pause } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect } from "react";

import type { VitalKey, Vitals as VitalsData } from "../../lib/controlRoomGraph";

/** Tweens an integer count when `value` changes; instant under reduced motion. */
function AnimatedCount({ value }: { value: number }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (v) => Math.round(v).toString());

  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.2, ease: "easeOut" });
    return () => controls.stop();
  }, [mv, value, reduce]);

  return <motion.span>{rounded}</motion.span>;
}

interface Props {
  vitals: VitalsData;
  active: VitalKey | null;
  onToggle: (key: VitalKey) => void;
}

const CHIPS: Array<{ key: VitalKey; label: string; icon: typeof Activity; tone: string }> = [
  { key: "inProgress", label: "진행중", icon: Activity, tone: "active" },
  { key: "blocked", label: "차단", icon: AlertTriangle, tone: "blocked" },
  { key: "awaitingHuman", label: "승인 대기", icon: Pause, tone: "pressure" },
];

export function Vitals({ vitals, active, onToggle }: Props) {
  return (
    <div className="cr-vitals">
      {CHIPS.map(({ key, label, icon: Icon, tone }) => (
        <button
          key={key}
          type="button"
          className="cr-vital"
          data-tone={tone}
          data-active={active === key || undefined}
          aria-pressed={active === key}
          onClick={() => onToggle(key)}
        >
          <Icon size={15} aria-hidden />
          <span className="cr-vital-n">
            <AnimatedCount value={vitals[key]} />
          </span>
          <span className="cr-vital-label">{label}</span>
        </button>
      ))}
      <div className="cr-vital cr-vital--static" data-tone="muted">
        <Boxes size={15} aria-hidden />
        <span className="cr-vital-n">
          <AnimatedCount value={vitals.sessions} />
        </span>
        <span className="cr-vital-label">세션</span>
      </div>
    </div>
  );
}
