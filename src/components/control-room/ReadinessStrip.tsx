import { AlertTriangle, Check, ShieldAlert, ShieldCheck, Wrench, X } from "lucide-react";

import type { ReadinessView } from "../../bindings";
import { type GoLiveRemedy, isArmed } from "../../lib/controlRoom";
import { Badge } from "../ui/badge";

const GATE_LABELS: { key: keyof ReadinessView["gates"]; label: string }[] = [
  { key: "preflight", label: "preflight" },
  { key: "conductor", label: "conductor" },
  { key: "observer", label: "observer" },
  { key: "auto", label: "auto" },
  { key: "stall", label: "stall" },
];

const EMPTY_REMEDIES: GoLiveRemedy[] = [];

/** ARMED/NOT-ARMED verdict badge + the 5 readiness gate chips. Rendered inside the Command
 *  Deck's "지금 POSTURE" zone; the blockers/warnings live in {@link ReadinessDetails} below the
 *  deck so a long blocker list never stretches the deck row. */
export function ReadinessGatesRow({ readiness }: { readiness: ReadinessView }) {
  const armed = isArmed(readiness.gates);
  return (
    <div className="cr-readiness-gates" data-armed={armed || undefined}>
      <Badge variant={armed ? "secondary" : "destructive"} className="cr-readiness-verdict">
        {armed ? <ShieldCheck size={12} aria-hidden /> : <ShieldAlert size={12} aria-hidden />}
        {armed ? "ARMED" : "NOT ARMED"}
      </Badge>
      {GATE_LABELS.map(({ key, label }) => {
        const pass = readiness.gates[key];
        return (
          <span key={key} className="cr-gate" data-pass={pass || undefined}>
            {pass ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
            {label}
          </span>
        );
      })}
    </div>
  );
}

/** Blockers (only when not armed) + Go-Live remedies (P1b: 실패 항목별 "어떻게 고침" 한 줄,
 *  같은 콘솔의 토글은 그 토글을 직접 지시) + advisory warnings. Rendered below the deck. */
export function ReadinessDetails({
  readiness,
  remedies = EMPTY_REMEDIES,
}: {
  readiness: ReadinessView;
  remedies?: GoLiveRemedy[];
}) {
  const armed = isArmed(readiness.gates);
  if (
    (armed || readiness.blockers.length === 0) &&
    readiness.warnings.length === 0 &&
    remedies.length === 0
  ) {
    return null;
  }
  return (
    <div className="cr-readiness-details">
      {!armed && readiness.blockers.length > 0 && (
        <ul className="cr-readiness-blockers">
          {readiness.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {remedies.length > 0 && (
        <ul className="cr-remedies" aria-label="Go-Live 체크리스트 처방">
          {remedies.map((r) => (
            <li key={r.key} className="cr-remedy">
              <Wrench size={12} aria-hidden />
              <span className="cr-remedy-gate">{r.gate}</span>
              <span className="cr-remedy-text">{r.remedy}</span>
            </li>
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
