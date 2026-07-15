import { RefreshCw } from "lucide-react";

import { cn } from "@/components/ui/cn";

type JobsSummary = {
  active: number;
  approval: number;
  failed: number;
  completed: number;
};

export function JobsHeader({
  tracking,
  fetching,
  summary,
}: {
  tracking: boolean;
  fetching: boolean;
  summary: JobsSummary;
}) {
  return (
    <header className="jobs-head" data-tauri-drag-region>
      <div className="jobs-head-inner">
        <div className="jobs-heading">
          <span className="jobs-eyebrow">AUTOMATION / RUN LEDGER</span>
          <div className="jobs-title-row">
            <h1>Jobs · Agent</h1>
            <span className="jobs-poll">
              <RefreshCw className={cn("size-3.5", fetching && "jobs-spin")} />
              {tracking ? "실행 추적 중" : "유휴"}
            </span>
          </div>
          <p>모든 실행은 한도 안에서 추적되며, 제안은 검토 후에만 반영됩니다.</p>
        </div>

        <section className="jobs-summary" aria-label="작업 상태 요약">
          <div className="jobs-summary-item" aria-label={`활성 작업 ${summary.active}개`}>
            <span>ACTIVE</span>
            <strong>{summary.active}</strong>
            <small>실행·대기</small>
          </div>
          <div className="jobs-summary-item" aria-label={`승인 대기 ${summary.approval}개`}>
            <span>APPROVAL</span>
            <strong>{summary.approval}</strong>
            <small>검토 필요</small>
          </div>
          <div className="jobs-summary-item" aria-label={`실패 ${summary.failed}개`}>
            <span>FAILED</span>
            <strong>{summary.failed}</strong>
            <small>확인 필요</small>
          </div>
          <div className="jobs-summary-item" aria-label={`완료 ${summary.completed}개`}>
            <span>COMPLETED</span>
            <strong>{summary.completed}</strong>
            <small>정상 종료</small>
          </div>
        </section>
      </div>
    </header>
  );
}
