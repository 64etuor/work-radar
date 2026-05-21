import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, ExternalLink, RefreshCw } from "lucide-react";

import type { CiStatus, PrRadarItem, ReadinessBucket } from "@/bindings";
import {
  PR_RADAR_POLL_MS,
  fetchPrRadar,
  openExternal,
  useCodexStatus,
  useProjects,
  useSetPrSelfCheck,
  useTriggerPrSelfcheck,
} from "@/lib/query";
import { useUIStore } from "@/store";

/** 5개 readiness 버킷 표시 순서 + 라벨 (PLAN.md Phase 4). */
const BUCKETS: { key: ReadinessBucket; label: string; hint: string }[] = [
  { key: "ci_blocked", label: "CI Blocked", hint: "CI 실패·충돌 — 머지 막힘" },
  { key: "needs_self_check", label: "Needs Self Check", hint: "self-check 필요 / draft" },
  { key: "ready", label: "Ready", hint: "머지 준비됨" },
  { key: "stale", label: "Stale", hint: "오래 멈춤" },
  { key: "merged_cleanup", label: "Merged Cleanup", hint: "머지됨 — 정리" },
];

const CI_LABEL: Record<CiStatus, string> = {
  passing: "CI 통과",
  failing: "CI 실패",
  pending: "CI 진행",
  none: "체크 없음",
};

/**
 * PR Radar — 멀티 레포 PR을 readiness 버킷별로(INVARIANT #4: 자기 뷰). 임계치 넘는 것만 매트릭스로
 * escalate되며, 그 escalate/auto-resolve는 Rust가 폴링 cycle에서 수행한다(보드는 signals로 반영).
 * 주기 폴링 + bounded backoff(INVARIANT #5)는 useQueries refetchInterval/retry로.
 */
export function PrRadarView() {
  const { goTo } = useUIStore();
  const qc = useQueryClient();
  const projects = useProjects();
  const projectList = projects.data ?? [];
  const setSelfCheck = useSetPrSelfCheck();
  const codex = useCodexStatus();
  const selfcheckDraft = useTriggerPrSelfcheck();
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;

  // 프로젝트별 주기 폴링(고정 cadence) + bounded retry(지수 backoff). 성공 시 매트릭스 invalidate.
  const results = useQueries({
    queries: projectList.map((p) => ({
      queryKey: ["prRadar", p.id],
      queryFn: async () => {
        const items = await fetchPrRadar(p.id);
        void qc.invalidateQueries({ queryKey: ["signals"] });
        return items;
      },
      refetchInterval: PR_RADAR_POLL_MS,
      refetchOnWindowFocus: false,
      retry: 2,
    })),
  });

  const items = results.flatMap((r) => r.data ?? []);
  const isFetching = results.some((r) => r.isFetching);
  const errors = results.map((r) => r.error).filter((e): e is Error => !!e);

  const grouped: Record<ReadinessBucket, PrRadarItem[]> = {
    ci_blocked: [],
    needs_self_check: [],
    ready: [],
    stale: [],
    merged_cleanup: [],
  };
  for (const it of items) grouped[it.bucket].push(it);

  const noProjects = projects.data && projectList.length === 0;
  const empty = !isFetching && items.length === 0 && errors.length === 0;

  return (
    <div className="pr">
      <header className="pr-head" data-tauri-drag-region>
        <button type="button" className="pr-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="pr-title">PR Radar</span>
        <span className="pr-poll">
          <RefreshCw className={`size-3.5${isFetching ? " pr-spin" : ""}`} />
          {isFetching ? "새로고침 중…" : "주기 폴링"}
        </span>
      </header>

      <div className="pr-scroll">
        {noProjects && (
          <div className="pr-empty">
            프로젝트가 없습니다 — 설정에서 GitHub 토큰·레포가 있는 프로젝트를 추가하세요.
          </div>
        )}
        {errors.length > 0 && (
          <div className="pr-err">
            일부 폴링 실패: {errors.map((e) => e.message).join(" · ")}
          </div>
        )}
        {selfcheckDraft.error && (
          <div className="pr-err">
            self-check 초안 실패: {(selfcheckDraft.error as Error).message}
          </div>
        )}
        {empty && !noProjects && (
          <div className="pr-empty">
            표시할 PR이 없습니다 — enabled GitHub 레포의 열린 PR이 여기 모입니다.
          </div>
        )}

        {!noProjects &&
          BUCKETS.map((b) => {
            const list = grouped[b.key];
            if (list.length === 0) return null;
            return (
              <section key={b.key} className="pr-bucket">
                <div className="pr-bucket-head">
                  <span className={`pr-bucket-name pr-b-${b.key}`}>{b.label}</span>
                  <span className="pr-bucket-hint">{b.hint}</span>
                  <span className="pr-bucket-count">{list.length}</span>
                </div>
                <div className="pr-cards">
                  {list.map((it) => (
                    <PrCard
                      key={`${it.repoFullName}#${it.number}`}
                      item={it}
                      codexReady={codexReady}
                      drafting={selfcheckDraft.isPending}
                      onToggleSelfCheck={(checked) =>
                        setSelfCheck.mutate({
                          repoFullName: it.repoFullName,
                          prNumber: it.number,
                          checked,
                        })
                      }
                      onSelfcheckDraft={() =>
                        selfcheckDraft.mutate(
                          {
                            projectId: it.projectId,
                            repoFullName: it.repoFullName,
                            prNumber: it.number,
                            prUrl: it.url,
                            timeoutSec: 120,
                            maxTurns: 8,
                            costCapUsd: 1.0,
                          },
                          { onSuccess: () => goTo("jobs") },
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
      </div>
    </div>
  );
}

function PrCard({
  item,
  codexReady,
  drafting,
  onToggleSelfCheck,
  onSelfcheckDraft,
}: {
  item: PrRadarItem;
  codexReady: boolean;
  drafting: boolean;
  onToggleSelfCheck: (checked: boolean) => void;
  onSelfcheckDraft: () => void;
}) {
  // 머지된 PR은 self-check 초안 대상 아님(정리 버킷).
  const canDraft = item.bucket !== "merged_cleanup";
  return (
    <div className="pr-card">
      <div className="pr-card-top">
        <span className="pr-repo">{item.repoFullName}</span>
        <span className="pr-num">#{item.number}</span>
        {item.escalated && <span className="pr-badge pr-esc">매트릭스 ↑</span>}
      </div>
      <div className="pr-card-title">{item.title}</div>
      <div className="pr-card-meta">
        <span className={`pr-ci pr-ci-${item.ci}`}>{CI_LABEL[item.ci]}</span>
        {item.hasConflict && <span className="pr-flag pr-conflict">충돌</span>}
        {item.isDraft && <span className="pr-flag">draft</span>}
        {item.linkedTicket && <span className="pr-flag pr-ticket">{item.linkedTicket}</span>}
        <span className="pr-age">{item.ageDays}d</span>
        <span className="pr-author">@{item.authorLogin}</span>
      </div>
      <div className="pr-card-actions">
        <label className="pr-selfcheck">
          <input
            type="checkbox"
            checked={item.selfChecked}
            onChange={(e) => onToggleSelfCheck(e.target.checked)}
          />
          self-check
        </label>
        {canDraft && (
          <button
            type="button"
            className="pr-draft"
            disabled={!codexReady || drafting}
            title={
              codexReady
                ? "codex로 self-check/설명 초안 생성 (제안 — Jobs에서 검토·accept)"
                : "codex 미가용 — 설치·로그인 후 사용"
            }
            onClick={onSelfcheckDraft}
          >
            <Bot className="size-3.5" />
            self-check 초안
          </button>
        )}
        <button
          type="button"
          className="pr-open"
          onClick={() => void openExternal(item.url)}
        >
          <ExternalLink className="size-3.5" />
          열기
        </button>
      </div>
    </div>
  );
}
