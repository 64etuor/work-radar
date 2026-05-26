import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Bot, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";

import type { CiStatus, PrRadarItem, ReadinessBucket } from "@/bindings";
import {
  PR_RADAR_POLL_MS,
  fetchPrRadar,
  openExternal,
  useCodexStatus,
  useProjects,
  useTriggerCiTriage,
  useTriggerPrSelfcheck,
} from "@/lib/query";
import { useUIStore } from "@/store";
import { Button } from "@/components/ui/button";

/** 5개 readiness 버킷 표시 순서 + 라벨 (PLAN.md Phase 4). */
const BUCKETS: { key: ReadinessBucket; label: string; hint: string }[] = [
  { key: "ci_blocked", label: "CI Blocked", hint: "CI 실패·충돌 — 머지 막힘" },
  { key: "needs_self_check", label: "Needs Review", hint: "코드 리뷰 필요 / draft" },
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
  const codex = useCodexStatus();
  const selfcheckDraft = useTriggerPrSelfcheck();
  const ciTriage = useTriggerCiTriage();
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
            코드 리뷰 실패: {(selfcheckDraft.error as Error).message}
          </div>
        )}
        {ciTriage.error && (
          <div className="pr-err">
            CI triage 실패: {(ciTriage.error as Error).message}
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
                <div className="pr-rows">
                  {list.map((it) => (
                    <PrRow
                      key={`${it.repoFullName}#${it.number}`}
                      item={it}
                      codexReady={codexReady}
                      drafting={selfcheckDraft.isPending}
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
                      triaging={ciTriage.isPending}
                      onCiTriage={() =>
                        ciTriage.mutate(
                          {
                            projectId: it.projectId,
                            repoFullName: it.repoFullName,
                            prNumber: it.number,
                            prUrl: it.url,
                            timeoutSec: 120,
                            maxTurns: 8,
                            costCapUsd: 1.0,
                          },
                          { onSuccess: (out) => goTo(out.escalated ? "board" : "jobs") },
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

function PrRow({
  item,
  codexReady,
  drafting,
  triaging,
  onSelfcheckDraft,
  onCiTriage,
}: {
  item: PrRadarItem;
  codexReady: boolean;
  drafting: boolean;
  triaging: boolean;
  onSelfcheckDraft: () => void;
  onCiTriage: () => void;
}) {
  // 머지된 PR은 코드 리뷰 대상 아님(정리 버킷).
  const canDraft = item.bucket !== "merged_cleanup";
  // CI triage는 CI Blocked 버킷만(원인/수정안 제안 + 재트리거 캡).
  const canTriage = item.bucket === "ci_blocked";
  return (
    <div className="prr-row">
      <div className="prr-id">
        <span className="prr-repo">{item.repoFullName}</span>
        <span className="prr-num">#{item.number}</span>
      </div>
      <div className="prr-title">{item.title}</div>
      <div className="prr-meta">
        <span className={`pr-ci pr-ci-${item.ci}`}>{CI_LABEL[item.ci]}</span>
        {item.hasConflict && <span className="pr-flag pr-conflict">충돌</span>}
        {item.isDraft && <span className="pr-flag">draft</span>}
        <span className={`prr-comments${item.isSuspicious ? " prr-suspicious" : ""}`}>
          {item.isSuspicious && <TriangleAlert className="size-3" />}
          {item.commentCount}
        </span>
        <span className="pr-age">{item.ageDays}d</span>
        <span className="pr-author">@{item.authorLogin}</span>
      </div>
      <div className="prr-actions">
        {canDraft && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1 rounded-full text-[11px] text-[color:var(--color-wr-action-blue,#2d6cdf)]"
            disabled={!codexReady || drafting}
            title={
              codexReady
                ? "codex로 코드 리뷰 초안 생성 (제안 — Jobs에서 검토·accept)"
                : "codex 미가용 — 설치·로그인 후 사용"
            }
            onClick={onSelfcheckDraft}
          >
            <Bot className="size-3.5" />
            코드 리뷰
          </Button>
        )}
        {canTriage && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1 rounded-full text-[11px] text-[color:var(--color-wr-action-blue,#2d6cdf)]"
            disabled={!codexReady || triaging}
            title={
              codexReady
                ? "codex로 CI 실패 원인/수정안 triage (제안 — 재트리거는 캡됨, 초과 시 Q1 escalate)"
                : "codex 미가용 — 설치·로그인 후 사용"
            }
            onClick={onCiTriage}
          >
            <Bot className="size-3.5" />
            CI triage
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-1 rounded-full text-[11px]"
          onClick={() => void openExternal(item.url)}
        >
          <ExternalLink className="size-3.5" />
          열기
        </Button>
      </div>
    </div>
  );
}
