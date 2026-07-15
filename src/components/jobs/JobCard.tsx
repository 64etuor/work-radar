import type { UseQueryResult } from "@tanstack/react-query";
import {
  CircleDollarSign,
  Copy,
  FileText,
  Hourglass,
  RotateCcw,
  Square,
  Timer,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AgentRunView } from "@/bindings";
import { formatElapsedCompact } from "@/lib/agentBar";

import { JOB_STATUS } from "./jobsConstants";
import { isPinnedToBottom, runDurationSec } from "./jobsUtils";
import { ProposalPanel } from "./ProposalPanel";

/**
 * 로그 본문 — 실행 중 잡은 폴링으로 내용이 늘어나므로, 사용자가 바닥에 붙어 있을 때만
 * 자동 follow(스크롤 점프). 위로 올려 읽는 중엔 위치를 보존한다(강제 점프 금지).
 */
function LogPane({ loading, text }: { loading: boolean; text: string | null }) {
  const ref = useRef<HTMLPreElement>(null);
  // 마지막 스크롤 기준 "바닥 근처" 여부 — 초기 열람은 최신부터(true).
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className="jobs-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = isPinnedToBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
      }}
    >
      {loading ? "로그 불러오는 중…" : (text ?? "(로그 없음)")}
    </pre>
  );
}

/** 로그 복사 버튼 — 클릭 시 1.5s "복사됨" 피드백(타이머는 언마운트 시 정리, bounded). */
function CopyLogButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="jobs-log-copy"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="로그 복사"
    >
      <Copy className="size-3" />
      {copied ? "복사됨" : "복사"}
    </button>
  );
}

export function JobCard({
  run,
  logOpen,
  log,
  onToggleLog,
  onKill,
}: {
  run: AgentRunView;
  logOpen: boolean;
  log: UseQueryResult<string, Error> | undefined;
  onToggleLog: () => void;
  onKill: () => void;
}) {
  const st = JOB_STATUS[run.status];
  // 실행/대기 중에만 kill (awaiting_approval은 프로세스 종료 → accept/reject로 처리).
  const killable = run.status === "running" || run.status === "proposed";
  // 종료 잡의 실제 실행 시간(정적 타임스탬프 차 — 시계 불요).
  const durationSec = runDurationSec(run.startedAt, run.finishedAt);
  const logText = log?.data?.trim() ? log.data : null;

  return (
    <article className="jobs-card" aria-label={`${st.label} ${run.kind} 실행`}>
      <div className="jobs-card-grid">
        <div className="jobs-card-main">
          <div className="jobs-card-top">
            <span className={`jobs-badge ${st.cls}`}>{st.label}</span>
            <span className="jobs-kind">{run.kind}</span>
            <span className="jobs-engine">{run.engine}</span>
            <span className="jobs-sandbox">{run.sandbox}</span>
          </div>

          {run.detail && run.status !== "failed" && <div className="jobs-detail">{run.detail}</div>}
          {run.detail && run.status === "failed" && (
            <details className="jobs-error-disclosure">
              <summary>
                <span className="jobs-error-label">오류 상세</span>
                <span className="jobs-error-preview">{run.detail}</span>
              </summary>
              <div className="jobs-error-body">{run.detail}</div>
            </details>
          )}
        </div>

        <div className="jobs-card-side">
          <div className="jobs-meta">
            <span className="jobs-meta-item" title="timeout bound">
              <Timer className="size-3" />
              {run.timeoutSec}s
            </span>
            <span className="jobs-meta-item" title="max turns">
              <RotateCcw className="size-3" />
              {run.maxTurns}턴
            </span>
            <span className="jobs-meta-item" title="cost cap">
              <CircleDollarSign className="size-3" />
              cap {(run.costCapUsd ?? 0).toFixed(2)}
            </span>
            {durationSec != null && (
              <span className="jobs-meta-item" title="실행 시간">
                <Hourglass className="size-3" />
                {formatElapsedCompact(durationSec)}
              </span>
            )}
            {run.costTokens != null && <span>{run.costTokens} tok</span>}
            {run.costUsd != null && <span>${run.costUsd.toFixed(4)}</span>}
          </div>

          <div className="jobs-card-actions">
            <button type="button" className="jobs-log-toggle" onClick={onToggleLog}>
              <FileText className="size-3.5" />
              로그 {logOpen ? "닫기" : "보기"}
            </button>
            {killable && (
              <button type="button" className="jobs-kill" onClick={onKill}>
                <Square className="size-3" />
                kill
              </button>
            )}
          </div>
        </div>
      </div>

      {run.status === "awaiting_approval" && <ProposalPanel run={run} />}

      {logOpen && (
        <div className="jobs-log-wrap">
          <div className="jobs-log-head">
            <span className="jobs-log-label">LOG</span>
            {logText != null && <CopyLogButton text={logText} />}
          </div>
          <LogPane loading={log?.isLoading ?? false} text={logText} />
        </div>
      )}
    </article>
  );
}
