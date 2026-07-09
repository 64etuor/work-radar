import { CheckCircle2, CircleSlash2, Sparkles, Target, TriangleAlert } from "lucide-react";

import type { LifeOsRecommendation, WeeklyFocus } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useAcceptLifeOsRecommendation,
  useDismissLifeOsRecommendation,
  useGenerateLifeOsReview,
  useLifeOsAuditEvents,
  useLifeOsRecommendations,
  useLifeOsReview,
  useRecordLifeOsAuditEvent,
  useSelectedWeeklyFocus,
} from "@/lib/query";

const KIND_LABEL: Record<LifeOsRecommendation["kind"], string> = {
  weekly_focus: "주간 도미노",
  // guardrail은 폐지됐다(2026-07-09 decisions.md). 생성 UI가 없어 이 추천은 더 이상 나오지
  // 않지만, kind는 아직 Rust enum에 남아 있어 Record가 이 키를 요구한다. 백엔드 teardown 때 제거.
  guardrail_recovery: "가드레일",
  q1_prevention: "예방",
  q3_containment: "위임/자동화",
  decision_task: "결정 과제",
  shrink_focus: "축소",
};

export function LifeOsAdvisorPanel({
  weekStart,
  rangeEnd,
  quarter,
}: {
  weekStart: string;
  rangeEnd: string;
  quarter: string;
}) {
  const review = useLifeOsReview(weekStart, quarter);
  const recommendations = useLifeOsRecommendations(weekStart);
  const weeklyFocus = useSelectedWeeklyFocus(weekStart);
  const auditEvents = useLifeOsAuditEvents(weekStart);
  const generateReview = useGenerateLifeOsReview();
  const acceptRecommendation = useAcceptLifeOsRecommendation();
  const dismissRecommendation = useDismissLifeOsRecommendation();
  const recordAudit = useRecordLifeOsAuditEvent();
  const focus = weeklyFocus.data ?? null;
  const proposed = (recommendations.data ?? []).filter((item) => item.status === "proposed");
  const accepted = (recommendations.data ?? []).filter((item) => item.status === "accepted");
  const diagnosis = review.data?.diagnosis ?? null;
  const signalHints = review.data?.signalReviews.slice(0, 4) ?? [];

  const generate = () => {
    generateReview.mutate({ weekStart, quarter, rangeStart: weekStart, rangeEnd });
  };

  return (
    <section className="wk-advisor">
      <div className="wk-sec-head">
        <Sparkles className="text-wr-subtle size-4" />
        <span className="wk-sec-name">Life OS</span>
        <Button
          variant="outline"
          size="sm"
          className="wk-advisor-run"
          onClick={generate}
          disabled={generateReview.isPending}
        >
          <Sparkles className="size-4" />
          정리
        </Button>
      </div>

      {diagnosis && (
        <div className="wk-advisor-diagnosis">
          <Badge variant="outline">Q1 {diagnosis.q1Count}</Badge>
          <Badge variant="outline">Q2 {diagnosis.q2Count}</Badge>
          <Badge variant="outline">Q3 {diagnosis.q3Count}</Badge>
          {diagnosis.dominantAreaKey && (
            <Badge variant="secondary">{diagnosis.dominantAreaKey}</Badge>
          )}
        </div>
      )}

      {signalHints.length > 0 && (
        <div className="wk-advisor-hints">
          {signalHints.map((hint) => (
            <div key={hint.signalId} className="wk-advisor-hint">
              <span className="typo-body-md">{hint.title}</span>
              <span className="typo-mono-label">
                {hint.areaKey} · {hint.quadrantHint ?? "hold"} · {hint.processingAction}
              </span>
            </div>
          ))}
        </div>
      )}

      {focus && (
        <FocusAuditRow
          focus={focus}
          disabled={recordAudit.isPending}
          onAudit={(outcome) =>
            recordAudit.mutate({
              weekStart,
              targetKind: "weekly_focus",
              targetId: focus.id,
              outcome,
              note: null,
            })
          }
        />
      )}

      <div className="wk-advisor-list">
        {proposed.map((item) => (
          <RecommendationRow
            key={item.id}
            recommendation={item}
            replaceExisting={!!focus}
            onAccept={() =>
              acceptRecommendation.mutate({
                recommendationId: item.id,
                replaceExisting: !!focus,
              })
            }
            onDismiss={() =>
              dismissRecommendation.mutate({
                recommendationId: item.id,
                reason: "weekly_review_dismissed",
              })
            }
            disabled={acceptRecommendation.isPending || dismissRecommendation.isPending}
          />
        ))}
        {proposed.length === 0 && (
          <div className="wk-advisor-empty typo-body-md">
            {review.data ? "적용 대기 중인 추천 없음" : "아직 생성된 정리 없음"}
          </div>
        )}
      </div>

      {(accepted.length > 0 || (auditEvents.data ?? []).length > 0) && (
        <div className="wk-advisor-foot typo-mono-label">
          적용 {accepted.length} · audit {(auditEvents.data ?? []).length}
        </div>
      )}
    </section>
  );
}

function RecommendationRow({
  recommendation,
  replaceExisting,
  disabled,
  onAccept,
  onDismiss,
}: {
  recommendation: LifeOsRecommendation;
  replaceExisting: boolean;
  disabled: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="wk-advisor-rec">
      <div className="wk-advisor-rec-main">
        <span className="wk-advisor-rec-meta typo-mono-label">
          {KIND_LABEL[recommendation.kind]} · {recommendation.confidence}%
        </span>
        <strong className="typo-body-strong">{recommendation.title}</strong>
        {recommendation.reason && (
          <span className="wk-advisor-rec-reason typo-body-md">{recommendation.reason}</span>
        )}
      </div>
      <div className="wk-advisor-rec-actions">
        <Button variant="outline" size="sm" onClick={onAccept} disabled={disabled}>
          <Target className="size-4" />
          {replaceExisting ? "교체" : "적용"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss} disabled={disabled}>
          <CircleSlash2 className="size-4" />
          보류
        </Button>
      </div>
    </article>
  );
}

function FocusAuditRow({
  focus,
  disabled,
  onAudit,
}: {
  focus: WeeklyFocus;
  disabled: boolean;
  onAudit: (outcome: "done" | "too_large" | "blocked") => void;
}) {
  return (
    <div className="wk-advisor-focus">
      <div>
        <span className="wk-advisor-rec-meta typo-mono-label">선택됨</span>
        <strong className="typo-body-strong">{focus.title}</strong>
      </div>
      <div className="wk-advisor-rec-actions">
        <Button variant="outline" size="sm" onClick={() => onAudit("done")} disabled={disabled}>
          <CheckCircle2 className="size-4" />
          완료
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onAudit("too_large")}
          disabled={disabled}
        >
          <TriangleAlert className="size-4" />
          너무 큼
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAudit("blocked")} disabled={disabled}>
          막힘
        </Button>
      </div>
    </div>
  );
}
