import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, ExternalLink, RefreshCw, Unlink } from "lucide-react";

import type { MismatchItem } from "@/bindings";
import {
  MISMATCH_POLL_MS,
  fetchMismatch,
  openExternal,
  useCodexStatus,
  useProjects,
  useTriggerMismatchDraft,
} from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * Status Mismatch — Notion 백로그 상태와 GitHub PR 머지 상태의 drift를 본다 (Phase 6, 차별점).
 * 정본 케이스: PR 머지됐는데 Notion 상태가 done 목록에 없음. 감지/dedup/auto-resolve는 Rust가 폴링
 * cycle에서 수행하고(매트릭스에 mismatch 카드로 escalate), 보드는 signals로 반영된다.
 * 설정(백로그 DB·done 상태 목록·GitHub+Notion 토큰)이 갖춰진 프로젝트만 결과를 낸다(미비 시 빈 결과).
 */
export function MismatchView() {
  const { goTo } = useUIStore();
  const qc = useQueryClient();
  const projects = useProjects();
  const projectList = projects.data ?? [];
  const codex = useCodexStatus();
  const mismatchDraft = useTriggerMismatchDraft();
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;

  // 프로젝트별 주기 폴링(고정 cadence) + bounded retry. 성공 시 매트릭스 invalidate.
  const results = useQueries({
    queries: projectList.map((p) => ({
      queryKey: ["mismatch", p.id],
      queryFn: async () => {
        const items = await fetchMismatch(p.id);
        void qc.invalidateQueries({ queryKey: ["signals"] });
        return items;
      },
      refetchInterval: MISMATCH_POLL_MS,
      refetchOnWindowFocus: false,
      retry: 2,
    })),
  });

  const items = results.flatMap((r) => r.data ?? []);
  const isFetching = results.some((r) => r.isFetching);
  const errors = results.map((r) => r.error).filter((e): e is Error => !!e);

  const noProjects = projects.data && projectList.length === 0;
  const empty = !isFetching && items.length === 0 && errors.length === 0;

  return (
    <div className="pr">
      <header className="pr-head" data-tauri-drag-region>
        <button type="button" className="pr-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="pr-title">Status Mismatch</span>
        <span className="pr-poll">
          <RefreshCw className={`size-3.5${isFetching ? " pr-spin" : ""}`} />
          {isFetching ? "새로고침 중…" : "주기 폴링"}
        </span>
      </header>

      <div className="pr-scroll">
        {noProjects && (
          <div className="pr-empty">
            프로젝트가 없습니다 — 설정에서 GitHub·Notion 토큰, 백로그 DB, 완료 상태가 있는
            프로젝트를 추가하세요.
          </div>
        )}
        {errors.length > 0 && (
          <div className="pr-err">
            일부 폴링 실패: {errors.map((e) => e.message).join(" · ")}
          </div>
        )}
        {mismatchDraft.error && (
          <div className="pr-err">
            해소 초안 실패: {(mismatchDraft.error as Error).message}
          </div>
        )}
        {empty && !noProjects && (
          <div className="pr-empty">
            drift가 없습니다 — PR이 머지됐는데 Notion 백로그 상태가 완료가 아닌 티켓이 여기 모입니다.
            (백로그 DB·완료 상태 목록 설정 필요)
          </div>
        )}

        {items.length > 0 && (
          <section className="pr-bucket">
            <div className="pr-bucket-head">
              <span className="pr-bucket-name pr-b-ci_blocked">Notion 미동기화</span>
              <span className="pr-bucket-hint">PR 머지됨 · Notion 상태 ≠ 완료</span>
              <span className="pr-bucket-count">{items.length}</span>
            </div>
            <div className="pr-cards">
              {items.map((it) => (
                <MismatchCard
                  key={`${it.projectId}:${it.ticket}`}
                  item={it}
                  codexReady={codexReady}
                  drafting={mismatchDraft.isPending}
                  onDraft={() =>
                    mismatchDraft.mutate(
                      {
                        projectId: it.projectId,
                        ticket: it.ticket,
                        prUrl: it.prUrl,
                        notionUrl: it.notionUrl,
                        currentStatus: it.notionStatus,
                        timeoutSec: 90,
                        maxTurns: 6,
                        costCapUsd: 0.5,
                      },
                      { onSuccess: () => goTo("jobs") },
                    )
                  }
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function MismatchCard({
  item,
  codexReady,
  drafting,
  onDraft,
}: {
  item: MismatchItem;
  codexReady: boolean;
  drafting: boolean;
  onDraft: () => void;
}) {
  return (
    <div className="pr-card">
      <div className="pr-card-top">
        <span className="pr-repo">
          <Unlink className="mr-1 inline size-3.5 text-wr-subtle" />
          {item.ticket}
        </span>
        <span className="pr-badge pr-esc">매트릭스 ↑</span>
      </div>
      <div className="pr-card-title">PR 머지됨 — Notion 상태 미동기화</div>
      <div className="pr-card-meta">
        <span className="pr-flag pr-conflict">
          Notion: {item.notionStatus ?? "(상태 없음)"}
        </span>
        <span className="pr-flag pr-ticket">{item.ticket}</span>
      </div>
      <div className="pr-card-actions">
        <button
          type="button"
          className="pr-draft"
          disabled={!codexReady || drafting}
          title={
            codexReady
              ? "codex로 Notion 상태 업데이트 초안 (제안 — Jobs에서 검토·accept, 실제 변경은 수동)"
              : "codex 미가용 — 설치·로그인 후 사용"
          }
          onClick={onDraft}
        >
          <Bot className="size-3.5" />
          해소 초안
        </button>
        <button
          type="button"
          className="pr-open"
          onClick={() => void openExternal(item.prUrl)}
        >
          <ExternalLink className="size-3.5" />
          PR 열기
        </button>
        <button
          type="button"
          className="pr-open"
          onClick={() => void openExternal(item.notionUrl)}
        >
          <ExternalLink className="size-3.5" />
          백로그 열기
        </button>
      </div>
    </div>
  );
}
