import { Sparkles, Target, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";

import type { BookkeepingBudgetPlanRow } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useBookkeepingBudgetPlanner,
  useDeleteBookkeepingBudget,
  useSetBookkeepingBudget,
} from "@/lib/query/bookkeeping";
import { useToastStore } from "@/lib/toast";

import { pushMutationError } from "../bookkeepingFieldUtils";
import { currency } from "../bookkeepingFormat";
import {
  BUDGET_SUGGESTION_MONTH_OPTIONS,
  DEFAULT_BUDGET_SUGGESTION_MONTHS,
  parseBudgetAmount,
  summarizeBudgetPlan,
} from "../budgetPlanner";
import { budgetBarPercent, isBudgetOverrun } from "../budgets";
import { EmptyState } from "./_shared";

/**
 * 카테고리별 예산 계획 표면 — 상위 카테고리 한도를 표로 편집하고, 직전 N개월(당월 제외) 평균을
 * 제안하며, 지출은 있으나 미설정인 카테고리를 강조한다. 백엔드 `bookkeeping_budget_planner`가
 * 한도·집행·롤오버·제안액을 합쳐 반환하므로 이 패널은 표현·편집 뮤테이션만 담당한다.
 */
export function BudgetPlannerPanel({
  month,
  projectId,
}: {
  month: string;
  projectId: string | null;
}) {
  const [monthsBack, setMonthsBack] = useState<number>(DEFAULT_BUDGET_SUGGESTION_MONTHS);
  // 인라인 한도 입력의 미저장 값(카테고리 코드 → 문자열). 저장 성공 시 제거해 서버 값으로 폴백.
  const [edits, setEdits] = useState<Record<string, string>>({});

  const planner = useBookkeepingBudgetPlanner(month, projectId, monthsBack);
  const setBudget = useSetBookkeepingBudget();
  const deleteBudget = useDeleteBookkeepingBudget();
  const pushSuccess = useToastStore((s) => s.pushSuccess);

  const rows = planner.data ?? [];
  const summary = summarizeBudgetPlan(rows);
  const pending = setBudget.isPending || deleteBudget.isPending;

  const clearEdit = (code: string) =>
    setEdits((prev) => {
      const next = { ...prev };
      delete next[code];
      return next;
    });

  const persist = (row: BookkeepingBudgetPlanRow, limitMinor: number, rollover: boolean) => {
    setBudget.mutate(
      {
        projectId,
        month,
        categoryCode: row.categoryCode,
        limitMinor,
        currency: row.currency,
        rollover,
        note: null,
      },
      {
        onSuccess: () => {
          clearEdit(row.categoryCode);
          pushSuccess(`${row.label} 예산을 저장했습니다`);
        },
        onError: (error) => pushMutationError("bookkeeping.budget", error),
      },
    );
  };

  const commitLimit = (row: BookkeepingBudgetPlanRow) => {
    const raw = edits[row.categoryCode];
    if (raw === undefined) return; // 편집하지 않음
    const parsed = parseBudgetAmount(raw);
    if (parsed === null || (row.hasBudget && parsed === row.limitMinor)) {
      clearEdit(row.categoryCode); // 무효/무변화 → 서버 값으로 복귀
      return;
    }
    persist(row, parsed, row.rollover);
  };

  const applySuggestion = (row: BookkeepingBudgetPlanRow) =>
    persist(row, row.suggestedMinor, row.rollover);

  const applyAllSuggestions = () => {
    for (const row of rows) {
      if (!row.hasBudget && row.suggestedMinor > 0) persist(row, row.suggestedMinor, false);
    }
  };

  const unsetWithSuggestion = rows.filter((r) => !r.hasBudget && r.suggestedMinor > 0).length;

  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <Target className="size-4" />
          카테고리별 예산
        </CardTitle>
        <CardDescription className="bk-card-desc">
          월별 상위 카테고리 한도 · 직전 {monthsBack}개월 평균 제안(당월 제외)
        </CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        <div className="bk-budget-kpis">
          <div className="bk-budget-kpi">
            <span className="typo-caption-sm text-muted-foreground">총 예산</span>
            <strong className="typo-body-strong">{currency.format(summary.totalLimitMinor)}</strong>
          </div>
          <div className="bk-budget-kpi">
            <span className="typo-caption-sm text-muted-foreground">총 지출</span>
            <strong className="typo-body-strong">{currency.format(summary.totalSpentMinor)}</strong>
          </div>
          <div className="bk-budget-kpi" data-overrun={summary.totalRemainingMinor < 0}>
            <span className="typo-caption-sm text-muted-foreground">총 잔여</span>
            <strong className="typo-body-strong">
              {currency.format(summary.totalRemainingMinor)}
            </strong>
          </div>
          <div className="bk-budget-kpi">
            <span className="typo-caption-sm text-muted-foreground">미설정</span>
            <strong className="typo-body-strong">{summary.unsetCount}</strong>
          </div>
        </div>

        <div className="bk-budget-toolbar">
          <label className="bk-budget-months">
            <span className="typo-caption-sm text-muted-foreground">제안 기준</span>
            <Select
              value={String(monthsBack)}
              onValueChange={(value) => setMonthsBack(Number(value))}
            >
              <SelectTrigger aria-label="제안 기준 개월 수">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUDGET_SUGGESTION_MONTH_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}개월
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || unsetWithSuggestion === 0}
            onClick={applyAllSuggestions}
          >
            <Wand2 className="size-4" />
            미설정 전체 제안 적용{unsetWithSuggestion > 0 ? ` (${unsetWithSuggestion})` : ""}
          </Button>
        </div>

        {rows.length === 0 ? (
          <EmptyState>지출·예산 없음</EmptyState>
        ) : (
          <Table className="bk-budget-table">
            <TableHeader>
              <TableRow>
                <TableHead>카테고리</TableHead>
                <TableHead className="text-right">제안({monthsBack}개월)</TableHead>
                <TableHead className="text-right">이번달 지출</TableHead>
                <TableHead className="text-right">예산 한도</TableHead>
                <TableHead>잔여·집행률</TableHead>
                <TableHead className="text-center">이월</TableHead>
                <TableHead aria-label="액션" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const overrun = row.hasBudget && isBudgetOverrun(row.remainingMinor);
                const percent = budgetBarPercent(row.pct ?? 0);
                const value = edits[row.categoryCode] ?? row.limitMinor?.toString() ?? "";
                return (
                  <TableRow
                    key={row.categoryCode}
                    data-unset={!row.hasBudget}
                    data-overrun={overrun}
                  >
                    <TableCell>
                      <span className="bk-budget-cat">
                        <strong className="typo-body-strong">{row.label}</strong>
                        {!row.hasBudget && <span className="bk-budget-unset-badge">미설정</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        type="button"
                        className="bk-budget-suggest"
                        disabled={pending || row.suggestedMinor === 0}
                        onClick={() => applySuggestion(row)}
                        title="이 제안액을 예산으로 적용"
                      >
                        <Sparkles className="size-3" />
                        {currency.format(row.suggestedMinor)}
                      </button>
                    </TableCell>
                    <TableCell className="typo-caption-sm text-right">
                      {currency.format(row.spentMinor)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        className="bk-budget-limit-input"
                        inputMode="numeric"
                        aria-label={`${row.label} 예산 한도`}
                        placeholder="미설정"
                        value={value}
                        disabled={pending}
                        onChange={(event) =>
                          setEdits((prev) => ({ ...prev, [row.categoryCode]: event.target.value }))
                        }
                        onBlur={() => commitLimit(row)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {row.hasBudget ? (
                        <span className="bk-budget-progress">
                          <span className="bk-budget-track" aria-hidden="true">
                            <span className="bk-budget-fill" style={{ width: `${percent}%` }} />
                          </span>
                          <span className="typo-caption-sm">
                            {overrun ? "초과" : "잔여"} {currency.format(row.remainingMinor)}
                            {row.rolloverInMinor > 0 &&
                              ` · 이월 ${currency.format(row.rolloverInMinor)}`}
                          </span>
                        </span>
                      ) : (
                        <span className="typo-caption-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        aria-label={`${row.label} 전월 잔액 이월`}
                        checked={row.rollover}
                        disabled={pending || !row.hasBudget}
                        onCheckedChange={(checked) => {
                          if (row.hasBudget && row.limitMinor != null) {
                            persist(row, row.limitMinor, checked === true);
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {row.hasBudget && row.budgetId && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`${row.label} 예산 삭제`}
                          disabled={pending}
                          onClick={() =>
                            deleteBudget.mutate(row.budgetId!, {
                              onSuccess: () => pushSuccess(`${row.label} 예산을 삭제했습니다`),
                              onError: (error) => pushMutationError("bookkeeping.budget", error),
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
