import { Activity, AlertTriangle, Boxes, Pause } from "lucide-react";

import type { VitalKey, Vitals as VitalsData } from "../../lib/controlRoomGraph";

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
          <span className="cr-vital-n">{vitals[key]}</span>
          <span className="cr-vital-label">{label}</span>
        </button>
      ))}
      <div className="cr-vital cr-vital--static" data-tone="muted">
        <Boxes size={15} aria-hidden />
        <span className="cr-vital-n">{vitals.sessions}</span>
        <span className="cr-vital-label">세션</span>
      </div>
    </div>
  );
}
