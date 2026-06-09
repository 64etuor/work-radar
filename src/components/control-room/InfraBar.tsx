import type { PreflightCheck, ProjectTickerStatusRow } from "../../bindings";
import { infraTone } from "../../lib/controlRoom";

/** Short human label per stable preflight id; falls back to the id. */
const LABELS: Record<string, string> = {
  cmux_socket: "cmux",
  cmux_binary: "cmux bin",
  git_worktree: "git",
  conductor_mode: "conductor",
  observer_mode: "observer",
  auto_mode: "auto",
  autonomy_level: "autonomy",
  session_role: "role",
};

export function InfraBar({
  infra,
  ticker,
}: {
  infra: PreflightCheck[];
  ticker: ProjectTickerStatusRow | null;
}) {
  return (
    <div className="cr-infra">
      {infra.map((check) => (
        <span
          key={check.id}
          className="cr-infra-chip"
          data-tone={infraTone(check)}
          title={check.detail}
        >
          {LABELS[check.id] ?? check.id}
        </span>
      ))}
      {ticker && (
        <span
          className="cr-infra-chip"
          data-tone={ticker.tickEnabled ? "ok" : "advisory"}
          title={`ticker ${ticker.tickEnabled ? "on" : "off"}${
            ticker.intervalSec ? ` · ${ticker.intervalSec}s` : " · manual"
          }`}
        >
          ticker {ticker.tickEnabled ? "●" : "○"}
          {ticker.intervalSec ? ` ${ticker.intervalSec}s` : ""}
        </span>
      )}
    </div>
  );
}
