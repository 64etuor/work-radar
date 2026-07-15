import type { WeeklyReview } from "@/bindings";
import { areaLabel } from "@/components/board/boardUtils";
import { fmtMinutes } from "@/lib/timeTotals";

export function WeeklyEvidence({ review }: { review: WeeklyReview | undefined }) {
  const flow = review?.throughput;
  const routine = review?.routineAdherence;
  const pullRequests = review?.prActivity;
  const time = review?.timeSpent;

  return (
    <section className="wk-evidence" aria-labelledby="wk-evidence-title">
      <div className="wk-section-title">
        <span className="wk-section-kicker">EVIDENCE</span>
        <h2 id="wk-evidence-title">이번 주 증거</h2>
        <p>처리량보다 흐름과 균형을 함께 봅니다.</p>
      </div>

      <div className="wk-evidence-grid" aria-label="주간 실행 증거">
        <section className="wk-evidence-group" aria-label="흐름">
          <span className="wk-evidence-label">FLOW</span>
          <div className="wk-evidence-metrics">
            <EvidenceMetric label="캡처" value={flow?.captured ?? 0} />
            <EvidenceMetric label="완료" value={flow?.completed ?? 0} />
            <EvidenceMetric label="승격" value={flow?.promoted ?? 0} />
          </div>
        </section>

        <section className="wk-evidence-group" aria-label="루틴">
          <span className="wk-evidence-label">ROUTINE</span>
          <div className="wk-evidence-primary">
            <strong>{routine?.ratePct ?? 0}%</strong>
            <span>
              {routine?.done ?? 0}/{routine?.due ?? 0} 이행
            </span>
          </div>
          <div className="wk-evidence-progress" aria-hidden="true">
            <span style={{ width: `${routine?.ratePct ?? 0}%` }} />
          </div>
        </section>

        <section className="wk-evidence-group" aria-label="풀 리퀘스트">
          <span className="wk-evidence-label">PULL REQUESTS</span>
          <div className="wk-evidence-metrics wk-evidence-metrics-two">
            <EvidenceMetric label="새 attention" value={pullRequests?.attentionNew ?? 0} />
            <EvidenceMetric label="정리됨" value={pullRequests?.resolved ?? 0} />
          </div>
        </section>

        <section className="wk-evidence-group" aria-label="집중 시간">
          <span className="wk-evidence-label">FOCUSED TIME</span>
          <div className="wk-evidence-primary">
            <strong>{fmtMinutes(time?.totalMin ?? 0)}</strong>
            <span>배치된 시간</span>
          </div>
          {(time?.byArea ?? []).length > 0 && (
            <ul className="wk-time-areas">
              {(time?.byArea ?? []).map((row) => (
                <li key={row.area ?? "untagged"} className="wk-time-area">
                  <span>{row.area ? areaLabel(row.area) : "미태깅"}</span>
                  <span>{fmtMinutes(row.totalMin)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

function EvidenceMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="wk-evidence-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
