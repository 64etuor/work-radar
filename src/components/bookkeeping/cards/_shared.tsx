import { currency } from "../bookkeepingFormat";
import { reportBarPercent } from "../reports";

export function ReportBar({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: "income" | "expense" | "net";
}) {
  const percent = reportBarPercent(value, max);
  return (
    <div className="bk-report-bar" data-tone={tone} data-negative={value < 0 ? "true" : "false"}>
      <span className="typo-caption-sm">{label}</span>
      <span className="bk-report-track" aria-hidden="true">
        <span className="bk-report-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="typo-caption-sm">{currency.format(value)}</span>
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bk-metric">
      <span className="text-muted-foreground typo-caption-sm">{label}</span>
      <strong className="typo-title-md">{value}</strong>
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return <div className="bk-empty typo-body-md">{children}</div>;
}
