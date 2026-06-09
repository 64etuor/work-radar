import { AlertTriangle, Check, ShieldAlert, ShieldCheck, X } from "lucide-react";

import type { ReadinessView } from "../../bindings";
import { isArmed } from "../../lib/controlRoom";
import { Badge } from "../ui/badge";

const GATE_LABELS: { key: keyof ReadinessView["gates"]; label: string }[] = [
  { key: "preflight", label: "preflight" },
  { key: "conductor", label: "conductor" },
  { key: "observer", label: "observer" },
  { key: "auto", label: "auto" },
  { key: "stall", label: "stall" },
];

export function ReadinessStrip({ readiness }: { readiness: ReadinessView }) {
  const armed = isArmed(readiness.gates);
  return (
    <div className="cr-readiness" data-armed={armed || undefined}>
      <div className="cr-readiness-gates">
        {GATE_LABELS.map(({ key, label }) => {
          const pass = readiness.gates[key];
          return (
            <span key={key} className="cr-gate" data-pass={pass || undefined}>
              {pass ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
              {label}
            </span>
          );
        })}
        <Badge variant={armed ? "secondary" : "destructive"} className="cr-readiness-verdict">
          {armed ? <ShieldCheck size={12} aria-hidden /> : <ShieldAlert size={12} aria-hidden />}
          {armed ? "ARMED" : "NOT ARMED"}
        </Badge>
      </div>
      {!armed && readiness.blockers.length > 0 && (
        <ul className="cr-readiness-blockers">
          {readiness.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {readiness.warnings.map((w) => (
        <div key={w} className="cr-readiness-warning">
          <AlertTriangle size={12} aria-hidden /> {w}
        </div>
      ))}
    </div>
  );
}
