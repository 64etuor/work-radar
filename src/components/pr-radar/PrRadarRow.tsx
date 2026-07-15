import { Bot, ExternalLink, MessageSquare, TriangleAlert } from "lucide-react";

import type { CiStatus, PrRadarItem } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

export type PrRadarRowActions = Readonly<{
  codexReady: boolean;
  commentThreshold: number;
  drafting: boolean;
  triaging: boolean;
  escalating: boolean;
  onSelfcheckDraft: (item: PrRadarItem) => void;
  onCiTriage: (item: PrRadarItem) => void;
  onAiEscalation: (item: PrRadarItem) => void;
  onOpen: (item: PrRadarItem) => void;
}>;

type PrRadarRowProps = Readonly<{
  item: PrRadarItem;
  actions: PrRadarRowActions;
}>;

const CI_LABEL: Readonly<Record<CiStatus, string>> = {
  passing: "CI 통과",
  failing: "CI 실패",
  pending: "CI 진행",
  none: "체크 없음",
};

export function PrRadarRow({ item, actions }: PrRadarRowProps) {
  const canDraft = item.bucket !== "merged_cleanup";
  const canTriage = item.bucket === "ci_blocked";
  const canEscalate =
    item.aiFlagged || item.commentCount > actions.commentThreshold || item.hasConflict;

  return (
    <article className="prr-row">
      <div className="prr-copy">
        <div className="prr-id">
          <span className="prr-repo typo-micro font-mono">{item.repoFullName}</span>
          <span className="prr-num typo-micro font-mono">#{item.number}</span>
        </div>
        <h3 className="prr-title typo-label-md">{item.title}</h3>
        <div className="prr-meta" aria-label={`PR #${item.number} evidence`}>
          <span className={`pr-ci pr-ci-${item.ci}`}>{CI_LABEL[item.ci]}</span>
          {item.hasConflict && <span className="pr-flag pr-conflict">충돌</span>}
          {item.isDraft && <span className="pr-flag">draft</span>}
          <span
            className={cn(
              "prr-comments typo-micro font-mono",
              item.isSuspicious && "prr-suspicious",
              item.hasUnreadAlert && "prr-unread-alert",
              item.hasCriticalAlert && "prr-critical-alert",
            )}
            title={commentSignalTitle(item)}
          >
            <MessageSquare aria-hidden="true" className="size-3" />
            {(item.isSuspicious || item.aiFlagged) && (
              <TriangleAlert aria-hidden="true" className="size-3" />
            )}
            {item.commentCount}
          </span>
          <span className="pr-age typo-micro font-mono">{item.ageDays}d</span>
          <span className="pr-author typo-micro font-mono">@{item.authorLogin}</span>
        </div>
      </div>

      <div className="prr-actions">
        {canDraft && (
          <Button
            variant="outline"
            size="pill-sm"
            className="gap-1 text-[color:var(--color-wr-action-blue)]"
            disabled={!actions.codexReady || actions.drafting}
            title={
              actions.codexReady
                ? "codex로 코드 리뷰 초안 생성 (제안 — Jobs에서 검토·accept)"
                : "codex 미가용 — 설치·로그인 후 사용"
            }
            onClick={() => actions.onSelfcheckDraft(item)}
          >
            <Bot aria-hidden="true" className="size-3.5" />
            코드 리뷰
          </Button>
        )}
        {canTriage && (
          <Button
            variant="outline"
            size="pill-sm"
            className="gap-1 text-[color:var(--color-wr-action-blue)]"
            disabled={!actions.codexReady || actions.triaging}
            title={
              actions.codexReady
                ? "codex로 CI 실패 원인/수정안 triage (제안 — 재트리거는 캡됨, 초과 시 Q1 escalate)"
                : "codex 미가용 — 설치·로그인 후 사용"
            }
            onClick={() => actions.onCiTriage(item)}
          >
            <Bot aria-hidden="true" className="size-3.5" />
            CI triage
          </Button>
        )}
        {canEscalate && (
          <Button
            variant="outline"
            size="pill-sm"
            className="gap-1 text-[color:var(--color-wr-coral)]"
            disabled={!actions.codexReady || actions.escalating}
            title={
              actions.codexReady
                ? "댓글/충돌 패턴을 AI가 근본 원인, 반복 리뷰 포인트, 소유권 후보로 분석합니다"
                : "codex 미가용 — 설치·로그인 후 사용"
            }
            onClick={() => actions.onAiEscalation(item)}
          >
            <Bot aria-hidden="true" className="size-3.5" />
            AI escalation
          </Button>
        )}
        <Button
          variant="outline"
          size="pill-sm"
          className="gap-1"
          onClick={() => actions.onOpen(item)}
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
          열기
        </Button>
      </div>
    </article>
  );
}

function commentSignalTitle(item: PrRadarItem): string {
  if (item.hasCriticalAlert) return "critical Inbox alert";
  if (item.hasUnreadAlert) return "unread Inbox alert";
  if (item.aiFlagged) return "AI analysis candidate";
  return "comments";
}
