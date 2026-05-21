import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  ExternalLink,
  FileText,
  RefreshCw,
  Square,
  X,
} from "lucide-react";

import type {
  AgentRunView,
  AgentStatus,
  PrSelfCheckProposal,
  SelfCheckItem,
} from "@/bindings";
import {
  openExternal,
  useAcceptProposal,
  useAgentLog,
  useAgentRuns,
  useCodexStatus,
  useKillAgentRun,
  usePrProposal,
  useRejectProposal,
  useTriggerCodexJob,
  useTriggerEchoJob,
} from "@/lib/query";
import { useUIStore } from "@/store";

/** run.trigger(JSON)에서 PR 링크 정보 추출 (없으면 null). */
function prTrigger(
  trigger: string | null,
): { prUrl: string; repoFullName: string; prNumber: number } | null {
  if (!trigger) return null;
  try {
    const v = JSON.parse(trigger);
    if (typeof v?.prUrl === "string") return v;
  } catch {
    /* 무시 — 트리거 없는 잡. */
  }
  return null;
}

/** 잡 상태 → 라벨/색 클래스 (PR Radar 버킷 톤 재사용). */
const STATUS: Record<AgentStatus, { label: string; cls: string }> = {
  proposed: { label: "큐 대기", cls: "jobs-st-proposed" },
  awaiting_approval: { label: "승인 대기", cls: "jobs-st-proposed" },
  running: { label: "실행 중", cls: "jobs-st-running" },
  succeeded: { label: "완료", cls: "jobs-st-succeeded" },
  failed: { label: "실패", cls: "jobs-st-failed" },
  cancelled: { label: "취소됨", cls: "jobs-st-cancelled" },
};

function isActive(s: AgentStatus): boolean {
  return s === "running" || s === "proposed" || s === "awaiting_approval";
}

/**
 * Jobs (Agent 스파인, Phase 7) — 잡 큐를 표시하고 테스트 잡을 트리거한다. 모든 잡은 bound되며
 * (timeout/max_turns/cost_cap/kill, INVARIANT #5) agent_runs에 영속된다(INVARIANT #7).
 * codex 미설치/미인증이면 codex 트리거는 비활성(graceful degrade) — 나머지(echo·목록·kill)는 정상.
 */
export function JobsView() {
  const { goTo } = useUIStore();
  const runs = useAgentRuns();
  const codex = useCodexStatus();
  const echoJob = useTriggerEchoJob();
  const codexJob = useTriggerCodexJob();
  const killJob = useKillAgentRun();

  const [prompt, setPrompt] = useState("");
  const list = runs.data ?? [];
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;

  return (
    <div className="jobs">
      <header className="jobs-head" data-tauri-drag-region>
        <button type="button" className="jobs-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="jobs-title">Jobs · Agent</span>
        <span className="jobs-poll">
          <RefreshCw className={`size-3.5${runs.isFetching ? " jobs-spin" : ""}`} />
          {list.some((r) => isActive(r.status)) ? "실행 추적 중" : "유휴"}
        </span>
      </header>

      <div className="jobs-scroll">
        {/* codex 가용성 배너 — graceful degrade 안내. */}
        <div
          className={`jobs-codex ${codexReady ? "jobs-codex-ok" : "jobs-codex-off"}`}
        >
          <Bot className="size-4" />
          <span>{codex.data?.detail ?? "codex 상태 확인 중…"}</span>
          {codex.data?.version && (
            <span className="jobs-codex-ver">{codex.data.version}</span>
          )}
        </div>

        {/* 테스트 잡 컨트롤 (codex 없이 bound/kill/로그 검증). */}
        <section className="jobs-controls">
          <div className="jobs-controls-row">
            <button
              type="button"
              className="jobs-btn"
              disabled={echoJob.isPending}
              onClick={() =>
                echoJob.mutate({
                  seconds: 0,
                  timeoutSec: 20,
                  message: "echo 테스트 — bound 내 실행",
                })
              }
            >
              Echo 잡 (즉시 완료)
            </button>
            <button
              type="button"
              className="jobs-btn"
              disabled={echoJob.isPending}
              onClick={() =>
                echoJob.mutate({
                  seconds: 30,
                  timeoutSec: 3,
                  message: "timeout 테스트 — 3s 후 kill",
                })
              }
            >
              Timeout 잡 (3s→kill)
            </button>
          </div>

          <div className="jobs-codex-form">
            <textarea
              className="jobs-prompt"
              placeholder={
                codexReady
                  ? "codex 잡 프롬프트 (read-only 샌드박스)…"
                  : "codex 미가용 — 설치·로그인 후 사용"
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!codexReady}
              rows={2}
            />
            <button
              type="button"
              className="jobs-btn jobs-btn-primary"
              disabled={!codexReady || codexJob.isPending || !prompt.trim()}
              onClick={() =>
                codexJob.mutate(
                  {
                    projectId: null,
                    repoId: null,
                    prompt,
                    timeoutSec: 60,
                    maxTurns: 8,
                    costCapUsd: 1.0,
                  },
                  { onSuccess: () => setPrompt("") },
                )
              }
            >
              codex 잡 실행
            </button>
          </div>
          {(echoJob.error || codexJob.error) && (
            <div className="jobs-err">
              {(echoJob.error as Error)?.message ??
                (codexJob.error as Error)?.message}
            </div>
          )}
        </section>

        {list.length === 0 && (
          <div className="jobs-empty">
            아직 잡이 없습니다 — 위 테스트 잡으로 스파인을 확인하세요.
          </div>
        )}

        <div className="jobs-list">
          {list.map((run) => (
            <JobCard
              key={run.id}
              run={run}
              onKill={() => killJob.mutate(run.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function JobCard({ run, onKill }: { run: AgentRunView; onKill: () => void }) {
  const [open, setOpen] = useState(false);
  const log = useAgentLog(run.id, open);
  const st = STATUS[run.status];
  // 실행/대기 중에만 kill (awaiting_approval은 프로세스 종료 → accept/reject로 처리).
  const killable = run.status === "running" || run.status === "proposed";

  return (
    <div className="jobs-card">
      <div className="jobs-card-top">
        <span className={`jobs-badge ${st.cls}`}>{st.label}</span>
        <span className="jobs-kind">{run.kind}</span>
        <span className="jobs-engine">{run.engine}</span>
        <span className="jobs-sandbox">{run.sandbox}</span>
        {killable && (
          <button type="button" className="jobs-kill" onClick={onKill}>
            <Square className="size-3" />
            kill
          </button>
        )}
      </div>

      {run.detail && <div className="jobs-detail">{run.detail}</div>}

      <div className="jobs-meta">
        <span title="timeout bound">⏱ {run.timeoutSec}s</span>
        <span title="max turns">↻ {run.maxTurns}턴</span>
        <span title="cost cap">$ {(run.costCapUsd ?? 0).toFixed(2)}</span>
        {run.costTokens != null && <span>· {run.costTokens} tok</span>}
        {run.costUsd != null && <span>· ${run.costUsd.toFixed(4)}</span>}
      </div>

      {/* Acceptance 게이트: 산출 Proposal을 사람이 검토·편집·accept (제출은 수동, INVARIANT #2). */}
      {run.status === "awaiting_approval" && <ProposalPanel run={run} />}

      <div className="jobs-card-actions">
        <button
          type="button"
          className="jobs-log-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <FileText className="size-3.5" />
          로그 {open ? "닫기" : "보기"}
        </button>
      </div>

      {open && (
        <pre className="jobs-log">
          {log.isLoading
            ? "로그 불러오는 중…"
            : log.data?.trim()
              ? log.data
              : "(로그 없음)"}
        </pre>
      )}
    </div>
  );
}

/**
 * Proposal 검토 패널 (awaiting_approval 잡). codex가 낸 self-check/설명/스크린샷/마이그레이션 초안을
 * 사람이 편집하고 accept하면 로컬에 반영된다. **GitHub 제출은 사람이 수동으로** 한다(INVARIANT #2).
 */
function ProposalPanel({ run }: { run: AgentRunView }) {
  const proposal = usePrProposal(run.id, true);
  const accept = useAcceptProposal();
  const reject = useRejectProposal();
  const pr = prTrigger(run.trigger);

  // 편집 가능한 로컬 사본 (proposal 로드 시 시드).
  const [draft, setDraft] = useState<PrSelfCheckProposal | null>(null);
  useEffect(() => {
    if (proposal.data) setDraft(normalizeProposal(proposal.data));
  }, [proposal.data]);

  if (proposal.isLoading) {
    return <div className="jobs-prop jobs-prop-loading">Proposal 불러오는 중…</div>;
  }
  if (proposal.error) {
    // 파싱 실패(codex가 형식 밖 출력) — raw를 노출하고 accept는 막는다(reject만).
    return (
      <div className="jobs-prop">
        <div className="jobs-prop-err">
          {(proposal.error as Error).message}
        </div>
        <div className="jobs-prop-actions">
          <button
            type="button"
            className="jobs-btn jobs-reject"
            disabled={reject.isPending}
            onClick={() => reject.mutate(run.id)}
          >
            <X className="size-3.5" />
            폐기
          </button>
        </div>
      </div>
    );
  }
  const d = draft ?? normalizeProposal(proposal.data ?? {});

  const setChecks = (checks: SelfCheckItem[]) =>
    setDraft({ ...d, selfChecks: checks });

  return (
    <div className="jobs-prop">
      {pr && (
        <button
          type="button"
          className="jobs-prop-pr"
          onClick={() => void openExternal(pr.prUrl)}
        >
          <ExternalLink className="size-3" />
          {pr.repoFullName} #{pr.prNumber}
        </button>
      )}

      <label className="jobs-prop-label">PR 설명 초안</label>
      <textarea
        className="jobs-prop-summary"
        value={d.summary ?? ""}
        rows={3}
        onChange={(e) => setDraft({ ...d, summary: e.target.value })}
      />

      <label className="jobs-prop-label">self-check 체크리스트</label>
      <div className="jobs-prop-checks">
        {(d.selfChecks ?? []).length === 0 && (
          <div className="jobs-prop-empty">(항목 없음)</div>
        )}
        {(d.selfChecks ?? []).map((c, i) => (
          <label key={i} className="jobs-prop-check">
            <input
              type="checkbox"
              checked={c.checked ?? false}
              onChange={(e) => {
                const next = [...(d.selfChecks ?? [])];
                next[i] = { ...c, checked: e.target.checked };
                setChecks(next);
              }}
            />
            <span>{c.item}</span>
            {c.note && <span className="jobs-prop-note">{c.note}</span>}
          </label>
        ))}
      </div>

      {(d.screenshotsNeeded ?? []).length > 0 && (
        <>
          <label className="jobs-prop-label">스크린샷 필요</label>
          <ul className="jobs-prop-ul">
            {(d.screenshotsNeeded ?? []).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {(d.migrationNotes ?? []).length > 0 && (
        <>
          <label className="jobs-prop-label">마이그레이션/배포 노트</label>
          <ul className="jobs-prop-ul">
            {(d.migrationNotes ?? []).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      <div className="jobs-prop-hint">
        accept하면 로컬 self-check가 표시됩니다. <b>GitHub 제출은 직접</b> 하세요(외부 무변경).
      </div>
      {(accept.error || reject.error) && (
        <div className="jobs-prop-err">
          {((accept.error ?? reject.error) as Error).message}
        </div>
      )}
      <div className="jobs-prop-actions">
        <button
          type="button"
          className="jobs-btn jobs-btn-primary"
          disabled={accept.isPending}
          onClick={() => accept.mutate({ runId: run.id, accepted: d })}
        >
          <Check className="size-3.5" />
          accept (로컬 반영)
        </button>
        <button
          type="button"
          className="jobs-btn jobs-reject"
          disabled={reject.isPending}
          onClick={() => reject.mutate(run.id)}
        >
          <X className="size-3.5" />
          폐기
        </button>
      </div>
    </div>
  );
}

/** Proposal 옵셔널 필드를 안전한 기본값으로 정규화. */
function normalizeProposal(p: PrSelfCheckProposal): PrSelfCheckProposal {
  return {
    summary: p.summary ?? "",
    selfChecks: p.selfChecks ?? [],
    screenshotsNeeded: p.screenshotsNeeded ?? [],
    migrationNotes: p.migrationNotes ?? [],
  };
}
