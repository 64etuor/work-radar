import { ChevronLeft, ChevronRight, Star, Target } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { MealLog, PlannedMeal } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { formatMonthDay, WEEKDAY_SHORT_SUN_FIRST } from "@/lib/localeFormat";
import {
  localToday,
  useDailyDietNutrition,
  useDailyDietNutritionRange,
  useDietGoals,
  useMealLogs,
  useMealPlanDetail,
  useMealPlans,
  useSetDietGoal,
} from "@/lib/query";

import {
  addDays,
  fmtKcal,
  kcalBand,
  MEAL_STATUS_LABEL,
  MEAL_TYPE_LABEL,
  num,
  PLAN_STATUS_LABEL,
} from "./dietFormat";

/** 'YYYY-MM-DD' → (요일, 월일) 라벨 — 하드코딩 금지, localeFormat 파생만 사용. */
function dayLabel(ymd: string): { weekday: string; monthDay: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  const weekday = WEEKDAY_SHORT_SUN_FIRST[new Date(y, (m ?? 1) - 1, d ?? 1, 12).getDay()] ?? "";
  return { weekday, monthDay: formatMonthDay(m ?? 1, d ?? 1) };
}

/** 로그의 영양 출처 태그 — 어떤 경로로 기록됐는지(계획/식품/레시피/자유). */
function logSource(log: MealLog): string {
  if (log.plannedMealId) return "계획";
  if (log.recipeId) return "레시피";
  if (log.foodId) return "식품";
  return "자유";
}

function mealKcal(meal: PlannedMeal): number {
  return meal.items.reduce((sum, item) => sum + num(item.kcal), 0);
}

export function HistorySection() {
  const today = localToday();
  const [date, setDate] = useState(today);
  const [goalOpen, setGoalOpen] = useState(false);

  // 주간 스트립 = 선택일까지 7일.
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(date, i - 6));
  const weekQueries = useDailyDietNutritionRange(weekDates);

  const { data: day } = useDailyDietNutrition(date);
  const { data: logs } = useMealLogs(date, date);

  // 그날의 계획 이행 — 날짜를 덮는 비보관 계획의 식사 상태(읽기 전용).
  const { data: plans } = useMealPlans();
  const coveringPlan =
    plans?.find((p) => p.status !== "archived" && p.startDate <= date && p.endDate >= date) ?? null;
  const { data: planDetail } = useMealPlanDetail(coveringPlan?.id ?? null);
  const mealsOfDay = planDetail?.meals.filter((m) => m.date === date) ?? [];

  const goal = day?.goal ?? null;
  const band = goal ? kcalBand(goal.calorieTarget, goal.calorieTolerancePct) : null;
  const actualKcal = num(day?.actual.kcal);
  const actualProtein = num(day?.actual.proteinG);
  // 스트립 스케일: 주간 최대 실섭취와 밴드 상한 중 큰 값.
  const stripMax = Math.max(band?.max ?? 0, ...weekQueries.map((q) => num(q.data?.actual.kcal)), 1);

  return (
    <section className="diet-section" aria-label="섭취 히스토리">
      <div className="diet-toolbar">
        <div className="diet-datenav">
          <Button
            variant="ghost"
            size="sm"
            aria-label="전날"
            onClick={() => setDate(addDays(date, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <DatePicker value={date} onChange={(d) => d && setDate(d)} />
          <Button
            variant="ghost"
            size="sm"
            aria-label="다음날"
            onClick={() => setDate(addDays(date, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
          {date !== today && (
            <Button variant="outline" size="sm" onClick={() => setDate(today)}>
              오늘
            </Button>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setGoalOpen(true)}>
          <Target className="size-4" /> 목표 관리
        </Button>
      </div>

      <div className="diet-stat-row">
        <div className="diet-stat">
          <span className="typo-label-sm">열량</span>
          <strong className="typo-title-sm">{fmtKcal(actualKcal)}</strong>
          {goal && band ? (
            <span
              className={cn("diet-stat-note typo-caption-sm", goal.kcalOk ? "is-ok" : "is-off")}
            >
              목표 {fmtKcal(goal.calorieTarget)} · 밴드 {Math.round(band.min)}–
              {Math.round(band.max)} · {num(goal.kcalDelta) >= 0 ? "+" : ""}
              {Math.round(num(goal.kcalDelta))}
            </span>
          ) : (
            <span className="diet-stat-note typo-caption-sm">활성 목표 없음</span>
          )}
        </div>
        <div className="diet-stat">
          <span className="typo-label-sm">단백질</span>
          <strong className="typo-title-sm">{Math.round(actualProtein)}g</strong>
          {goal?.proteinMinG != null ? (
            <span
              className={cn("diet-stat-note typo-caption-sm", goal.proteinOk ? "is-ok" : "is-off")}
            >
              최소 {Math.round(num(goal.proteinMinG))}g {goal.proteinOk ? "충족" : "미달"}
            </span>
          ) : (
            <span className="diet-stat-note typo-caption-sm">최소 목표 없음</span>
          )}
        </div>
        <div className="diet-stat">
          <span className="typo-label-sm">기록</span>
          <strong className="typo-title-sm">{day?.logsCount ?? 0}건</strong>
          <span className="diet-stat-note typo-caption-sm">
            계획분 {fmtKcal(day?.planned.kcal)}
          </span>
        </div>
      </div>

      <div className="diet-strip" role="group" aria-label="최근 7일 열량">
        {weekDates.map((d, i) => {
          const q = weekQueries[i];
          const kcal = num(q?.data?.actual.kcal);
          const dayGoal = q?.data?.goal ?? null;
          const label = dayLabel(d);
          const heightPct = Math.min(100, (kcal / stripMax) * 100);
          return (
            <button
              key={d}
              type="button"
              className={cn("diet-strip-day", d === date && "is-selected")}
              onClick={() => setDate(d)}
              aria-label={`${label.monthDay} ${fmtKcal(kcal)}`}
            >
              <span className="diet-strip-barwrap">
                <span
                  className={cn(
                    "diet-strip-bar",
                    dayGoal == null ? "tone-none" : dayGoal.kcalOk ? "tone-ok" : "tone-off",
                  )}
                  style={{ height: `${heightPct}%` }}
                />
              </span>
              <span className="typo-caption-sm">{label.weekday}</span>
              <span className="diet-strip-date typo-micro">{label.monthDay}</span>
            </button>
          );
        })}
      </div>

      <div className="diet-panel">
        <h2 className="typo-body-strong">섭취 기록</h2>
        {logs == null || logs.length === 0 ? (
          <EmptyState className="diet-empty" title="기록 없음">
            이날 남은 섭취 기록이 없다. 기록은 Hermes가 남긴다.
          </EmptyState>
        ) : (
          <ul className="diet-log-list">
            {logs.map((log) => (
              <li key={log.id} className="diet-log-row">
                <span className="diet-log-time typo-mono-label">{log.at.slice(11, 16)}</span>
                <span className="diet-log-desc typo-body-md">
                  {log.description ?? "(설명 없음)"}
                  <Badge variant="outline" className="diet-log-source">
                    {logSource(log)}
                  </Badge>
                </span>
                <span className="diet-log-macros typo-label-sm">
                  {fmtKcal(log.kcal)} · P {Math.round(num(log.proteinG))}g
                </span>
                {(log.satisfaction != null || log.fullness != null) && (
                  <span className="diet-log-feel typo-caption-sm">
                    {log.satisfaction != null && (
                      <>
                        <Star className="size-3" /> {log.satisfaction}
                      </>
                    )}
                    {log.fullness != null && <> 포만 {log.fullness}</>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="diet-panel">
        <h2 className="typo-body-strong">
          계획 이행
          {coveringPlan && (
            <Badge variant="outline" className="diet-plan-badge">
              {PLAN_STATUS_LABEL[coveringPlan.status]} · {coveringPlan.startDate.slice(5)}~
              {coveringPlan.endDate.slice(5)}
            </Badge>
          )}
        </h2>
        {mealsOfDay.length === 0 ? (
          <EmptyState className="diet-empty" title="계획 없음">
            이날을 덮는 식단 계획이 없다. 계획 생성은 Hermes 몫.
          </EmptyState>
        ) : (
          <ul className="diet-meal-list">
            {mealsOfDay.map((meal) => (
              <li key={meal.id} className="diet-meal-row">
                <span className="diet-meal-type typo-label-sm">
                  {MEAL_TYPE_LABEL[meal.mealType]}
                  {meal.scheduledTime && <span className="typo-micro"> {meal.scheduledTime}</span>}
                </span>
                <span className="diet-meal-items typo-body-md">
                  {meal.items.length === 0
                    ? "(항목 없음)"
                    : meal.items.map((i) => i.label).join(", ")}
                </span>
                <span className="typo-label-sm">{fmtKcal(mealKcal(meal))}</span>
                <Badge
                  variant="outline"
                  className={cn("diet-meal-status", `status-${meal.status}`)}
                >
                  {MEAL_STATUS_LABEL[meal.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <GoalDialog open={goalOpen} onOpenChange={setGoalOpen} today={today} />
    </section>
  );
}

/**
 * 목표 관리 — append-only 버전. MCP 표면에 없는 사람 결정 레일이라 앱이 유일한 입력면이다.
 */
function GoalDialog({
  open,
  onOpenChange,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <GoalDialogBody today={today} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function GoalDialogBody({ today, onDone }: { today: string; onDone: () => void }) {
  const { data: goals } = useDietGoals();
  const setGoal = useSetDietGoal();
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [calorieTarget, setCalorieTarget] = useState("");
  const [tolerancePct, setTolerancePct] = useState("");
  const [proteinMin, setProteinMin] = useState("");
  const [note, setNote] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (setGoal.isPending) return;
    const kcal = Number(calorieTarget);
    if (!Number.isFinite(kcal) || kcal <= 0) return;
    const tolerance = tolerancePct.trim() === "" ? null : Number(tolerancePct);
    const protein = proteinMin.trim() === "" ? null : Number(proteinMin);
    await setGoal.mutateAsync({
      effectiveDate,
      calorieTarget: kcal,
      calorieTolerancePct: Number.isFinite(tolerance ?? NaN) ? tolerance : null,
      proteinMinG: Number.isFinite(protein ?? NaN) ? protein : null,
      fatMinG: null,
      carbTargetG: null,
      fiberMinG: null,
      note: note.trim() || null,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>영양 목표</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">적용 시작일</span>
            <DatePicker value={effectiveDate} onChange={(d) => d && setEffectiveDate(d)} />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">목표 열량 (kcal)</span>
            <Input
              inputMode="numeric"
              value={calorieTarget}
              onChange={(e) => setCalorieTarget(e.target.value)}
              placeholder="2200"
              required
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">허용 편차 (%)</span>
            <Input
              inputMode="numeric"
              value={tolerancePct}
              onChange={(e) => setTolerancePct(e.target.value)}
              placeholder="10"
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">최소 단백질 (g)</span>
            <Input
              inputMode="numeric"
              value={proteinMin}
              onChange={(e) => setProteinMin(e.target.value)}
              placeholder="140"
            />
          </label>
        </div>
        <label className="diet-field">
          <span className="typo-label-sm">메모</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="감량 페이즈" />
        </label>
        <div className="diet-form-actions">
          <Button type="submit" disabled={setGoal.isPending}>
            새 버전 추가
          </Button>
        </div>
      </form>
      <div className="diet-goal-history">
        <h3 className="typo-label-sm">버전 이력 (append-only)</h3>
        {goals == null || goals.length === 0 ? (
          <EmptyState className="diet-empty">아직 목표가 없다.</EmptyState>
        ) : (
          <ul className="diet-goal-list">
            {goals.map((g) => (
              <li key={g.id} className="diet-goal-row typo-body-md">
                <span className="typo-mono-label">{g.effectiveDate}</span>
                <span>
                  {fmtKcal(g.calorieTarget)} ±{Math.round(num(g.calorieTolerancePct))}%
                  {g.proteinMinG != null && ` · P ≥ ${Math.round(num(g.proteinMinG))}g`}
                </span>
                {g.note && <span className="typo-caption-sm">{g.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
