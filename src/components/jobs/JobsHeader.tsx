import { RefreshCw } from "lucide-react";

export function JobsHeader({ tracking, fetching }: { tracking: boolean; fetching: boolean }) {
  return (
    <header className="jobs-head" data-tauri-drag-region>
      <span className="jobs-title">Jobs · Agent</span>
      <span className="jobs-poll">
        <RefreshCw className={`size-3.5${fetching ? "jobs-spin" : ""}`} />
        {tracking ? "실행 추적 중" : "유휴"}
      </span>
    </header>
  );
}
