import { RefreshCw } from "lucide-react";
import type { RefCallback } from "react";

import type { PrRadarItem } from "@/bindings";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";

import { groupPrRadarItems, PR_RADAR_BUCKETS, summarizePrRadar } from "./prRadarModel";
import type { PrRadarRowActions } from "./PrRadarRow";
import { PrRadarRow } from "./PrRadarRow";

export type PrRadarDeskActions = PrRadarRowActions;

export type PrRadarDeskStatus = Readonly<{
  isFetching: boolean;
  pollIntervalMinutes: number;
  noProjects: boolean;
  pollingErrors: readonly string[];
  actionErrors: readonly string[];
}>;

type PrRadarDeskProps = Readonly<{
  items: readonly PrRadarItem[];
  status: PrRadarDeskStatus;
  actions: PrRadarDeskActions;
  scrollRef?: RefCallback<HTMLElement>;
}>;

export function PrRadarDesk({ items, status, actions, scrollRef }: PrRadarDeskProps) {
  const grouped = groupPrRadarItems(items);
  const summary = summarizePrRadar(items);
  const initialPolling = status.isFetching && items.length === 0 && !status.noProjects;
  const empty =
    !status.isFetching &&
    items.length === 0 &&
    !status.noProjects &&
    status.pollingErrors.length === 0;

  return (
    <div className="pr">
      <div className="pr-scroll" ref={scrollRef}>
        <header className="pr-head" data-tauri-drag-region>
          <div className="pr-title">
            <span className="pr-eyebrow typo-mono-label">CODE / MERGE READINESS</span>
            <h1>PR Radar</h1>
            <p className="typo-body-md">병목을 읽고, 제안은 검토한 뒤 실행하는 merge desk.</p>
          </div>
          <span className="pr-poll typo-micro font-mono">
            <RefreshCw
              aria-hidden="true"
              className={cn("size-3.5", status.isFetching && "pr-spin")}
            />
            {status.isFetching ? "새로고침 중…" : `${status.pollIntervalMinutes}분 폴링`}
          </span>
        </header>

        <PrRadarMessages status={status} initialPolling={initialPolling} empty={empty} />

        {items.length > 0 && (
          <>
            <section className="pr-brief" aria-label="PR readiness summary">
              <div className="pr-brief-lead">
                <span className="pr-section-label typo-mono-label">PORTFOLIO PRESSURE</span>
                <span className="pr-brief-term typo-caption-sm">Attention queue</span>
                <p className="typo-title-md">
                  <strong>{summary.attention}</strong>개 PR이 지금 주의가 필요합니다.
                </p>
                <span className="pr-brief-note typo-micro font-mono">
                  Total {summary.total} · Critical alerts {summary.critical} · Suspicious{" "}
                  {summary.suspicious} · Average age {summary.averageAgeDays}d
                </span>
              </div>
              <ul className="pr-readiness" aria-label="PR readiness counts">
                {PR_RADAR_BUCKETS.map((bucket) => (
                  <li key={bucket.key} className={`pr-readiness-${bucket.key}`}>
                    <span>{bucket.label}</span>
                    <strong>{summary.counts[bucket.key]}</strong>
                  </li>
                ))}
              </ul>
            </section>

            <div className="pr-ledger" aria-label="PR readiness ledger">
              {PR_RADAR_BUCKETS.map((bucket) => {
                const bucketItems = grouped[bucket.key];
                if (bucketItems.length === 0) return null;

                return (
                  <section key={bucket.key} className="pr-bucket">
                    <div className="pr-bucket-head">
                      <div>
                        <h2 className={`pr-bucket-name typo-mono-label pr-b-${bucket.key}`}>
                          {bucket.label}
                        </h2>
                        <p className="pr-bucket-hint typo-caption-sm">{bucket.hint}</p>
                      </div>
                      <span className="pr-bucket-count typo-mono-label">{bucketItems.length}</span>
                    </div>
                    <div className="pr-rows">
                      {bucketItems.map((item) => (
                        <PrRadarRow
                          key={`${item.repoFullName}#${item.number}`}
                          item={item}
                          actions={actions}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type PrRadarMessagesProps = Readonly<{
  status: PrRadarDeskStatus;
  initialPolling: boolean;
  empty: boolean;
}>;

function PrRadarMessages({ status, initialPolling, empty }: PrRadarMessagesProps) {
  return (
    <>
      {status.noProjects && (
        <EmptyState className="pr-empty">
          프로젝트가 없습니다. 설정에서 GitHub 토큰·레포가 있는 프로젝트를 추가하세요.
        </EmptyState>
      )}
      {status.pollingErrors.map((message) => (
        <div key={message} className="pr-err typo-body-md">
          {message}
        </div>
      ))}
      {status.actionErrors.map((message) => (
        <div key={message} className="pr-err typo-body-md">
          {message}
        </div>
      ))}
      {initialPolling && (
        <div className="pr-loading" role="status">
          <span className="pr-section-label typo-mono-label">SYNCING REPOSITORIES</span>
          <p className="typo-title-md">첫 PR 목록을 불러오는 중입니다.</p>
          <span className="typo-caption-sm">
            프로젝트별 GitHub 상태를 확인한 뒤 readiness 원장을 채웁니다.
          </span>
        </div>
      )}
      {empty && (
        <EmptyState className="pr-empty">
          표시할 PR이 없습니다. enabled GitHub 레포의 열린 PR이 여기 모입니다.
        </EmptyState>
      )}
    </>
  );
}
