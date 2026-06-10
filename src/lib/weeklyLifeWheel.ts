import type { WeeklyReview } from "@/bindings";

/**
 * Weekly **work** life-wheel 점수 헬퍼 — `WeeklyReview` 집계(지난 7일)를 6–8개 레이더 축으로
 * 환원하는 **순수 함수**. 부수효과·IO·외부 호출 없음(렌더 직전 파생 전용).
 *
 * ⚠️ 용어 주의: 여기서 "life-wheel"은 **주간 작업 차원 레이더**(흐름/실행/산출/PR/루틴/부채)다.
 * `lifeWheelDefaults.ts`의 area-tag(건강/업무/학습…) 라이프휠과는 별개 개념이다.
 *
 * 데이터 정책: **기존 집계만 사용**한다(새 IPC/필드 없음). 0/희소 데이터는 오해를 부르는 100점
 * 대신 `empty`(점수 산출 근거 없음 → score=null) 또는 `sparse`(근거는 있으나 표본 빈약) confidence로
 * 표시한다. 예: 예정 루틴 0건일 때 이행률을 100%로 보이게 하지 않는다(due=0 → empty).
 */

/** 축 신뢰도. measured=충분, sparse=근거 있으나 빈약(점수는 표시·플래그), empty=근거 없음(score=null). */
export type LifeWheelConfidence = "measured" | "sparse" | "empty";

/** 레이더 축 id (안정 식별자). */
export type LifeWheelAxisId =
  | "flow"
  | "execution"
  | "promotion"
  | "pr_hygiene"
  | "routine"
  | "debt_health"
  | "cleanup_momentum";

/** 한 레이더 축. */
export type LifeWheelAxis = {
  id: LifeWheelAxisId;
  /** 표시 라벨(ko). */
  label: string;
  /** 0..100 점수. confidence==="empty"면 null(근거 없음 — 0과 구분). */
  score: number | null;
  confidence: LifeWheelConfidence;
  /** 사람이 읽을 산출 근거(툴팁용). PII/시크릿 없음 — 카운트만. */
  detail: string;
};

/** 주간 작업 life-wheel 결과. */
export type WeeklyLifeWheel = {
  /** 고정 순서 7축(flow→execution→promotion→pr_hygiene→routine→debt_health→cleanup_momentum). */
  axes: LifeWheelAxis[];
  /** 근거 있는 축(score!==null) 평균. 전부 empty면 null. */
  overall: number | null;
  /** score!==null 인 축 수(레이더 채워짐 정도). */
  measuredCount: number;
};

/**
 * 점수화 소프트 타깃/임계치. 주관적 기본값이라 호출자가 override 가능(테스트·튜닝).
 * 카운트는 "이만큼이면 100점"으로 포화시키고, 부채는 "이만큼이면 0점"으로 역포화한다.
 */
export type LifeWheelTargets = {
  /** 주간 캡처 수 → 100점 기준. */
  capture: number;
  /** 주간 완료 수 → 100점 기준. */
  completion: number;
  /** 주간 승격 수 → 100점 기준. */
  promotion: number;
  /** 미해결 부채 합(미분류+Q1 overdue+stale) 이 값 이상이면 debt_health 0점. */
  debtTolerance: number;
  /** cleanup_momentum 반치(half-range): 부채 이만큼 감소=+50점(→100), 동량 증가=-50(→0). */
  momentumScale: number;
  /** 양수지만 이 값 이하의 표본은 sparse 로 플래그. */
  sparseFloor: number;
};

/** 기본 타깃 — 캡처/완료=하루 1건(7/주), 승격=3/주, 부채 허용=15, 모멘텀 반치=8. */
export const DEFAULT_LIFE_WHEEL_TARGETS: LifeWheelTargets = {
  capture: 7,
  completion: 7,
  promotion: 3,
  debtTolerance: 15,
  momentumScale: 8,
  sparseFloor: 2,
};

/** 0..100 정수로 clamp(비유한·음수 방어). */
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 카운트 음수 방어(집계는 ≥0이어야 하나 방어적). */
function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 카운트 → 소프트 타깃 대비 포화 점수 축(흐름/실행/산출 공통). count=0 → empty. */
function throughputAxis(
  id: LifeWheelAxisId,
  label: string,
  rawCount: number,
  target: number,
  sparseFloor: number,
): LifeWheelAxis {
  const count = nonNeg(rawCount);
  if (count === 0) {
    return { id, label, score: null, confidence: "empty", detail: "이번 주 데이터 없음" };
  }
  const score = target > 0 ? clampPct((count / target) * 100) : 0;
  const confidence: LifeWheelConfidence = count <= sparseFloor ? "sparse" : "measured";
  return { id, label, score, confidence, detail: `${count} / 목표 ${target}` };
}

/** PR 위생: 전체 PR 활동 중 정리(resolved) 비율. 활동 0 → empty(미적용). */
function prHygieneAxis(rawNew: number, rawResolved: number, sparseFloor: number): LifeWheelAxis {
  const attentionNew = nonNeg(rawNew);
  const resolved = nonNeg(rawResolved);
  const total = attentionNew + resolved;
  if (total === 0) {
    return {
      id: "pr_hygiene",
      label: "PR 위생",
      score: null,
      confidence: "empty",
      detail: "PR 활동 없음",
    };
  }
  const score = clampPct((resolved / total) * 100);
  const confidence: LifeWheelConfidence = total <= sparseFloor ? "sparse" : "measured";
  return {
    id: "pr_hygiene",
    label: "PR 위생",
    score,
    confidence,
    detail: `정리 ${resolved} / 활동 ${total}`,
  };
}

/** 루틴 이행률: done/due. due=0 → empty(오해 부르는 100% 방지 — 핵심 케이스). */
function routineAxis(rawDue: number, rawDone: number, sparseFloor: number): LifeWheelAxis {
  const due = nonNeg(rawDue);
  const done = nonNeg(rawDone);
  if (due === 0) {
    return {
      id: "routine",
      label: "루틴",
      score: null,
      confidence: "empty",
      detail: "예정 루틴 없음",
    };
  }
  const score = clampPct((done / due) * 100);
  const confidence: LifeWheelConfidence = due <= sparseFloor ? "sparse" : "measured";
  return { id: "routine", label: "루틴", score, confidence, detail: `${done}/${due}` };
}

/** 한 부채 스냅샷의 "미해결 부채 합"(미분류+Q1 overdue+stale). cleanupNeeded는 모멘텀 축에서만. */
function openDebtLoad(p: WeeklyReview["debtTrend"][number]): number {
  return nonNeg(p.unclassified) + nonNeg(p.q1Overdue) + nonNeg(p.staleBacklog);
}

/** cleanup 포함 전체 부채 합(모멘텀 비교용). */
function totalDebtLoad(p: WeeklyReview["debtTrend"][number]): number {
  return openDebtLoad(p) + nonNeg(p.cleanupNeeded);
}

/** 부채 건강: 최신 스냅샷의 미해결 부채를 역포화(0=100점, tolerance 이상=0점). 데이터 없으면 empty. */
function debtHealthAxis(
  debtTrend: WeeklyReview["debtTrend"],
  debtTolerance: number,
): LifeWheelAxis {
  if (debtTrend.length === 0) {
    return {
      id: "debt_health",
      label: "부채 건강",
      score: null,
      confidence: "empty",
      detail: "추세 데이터 없음",
    };
  }
  const last = debtTrend[debtTrend.length - 1];
  const load = openDebtLoad(last);
  const score =
    debtTolerance > 0 ? clampPct(100 - (load / debtTolerance) * 100) : load === 0 ? 100 : 0;
  // 표본(누적 일수)이 적으면 스냅샷 신뢰도 낮음 → sparse.
  const confidence: LifeWheelConfidence = debtTrend.length < 3 ? "sparse" : "measured";
  return {
    id: "debt_health",
    label: "부채 건강",
    score,
    confidence,
    detail: `미해결 부채 ${load}`,
  };
}

/**
 * 정리/백로그 모멘텀: 창(window) 첫날 대비 마지막날 전체 부채 변화.
 * 감소=개선(>50점), 증가=악화(<50점), 변화없음=50(중립).
 * 1일치뿐이면 모멘텀 산출 불가 → empty. 창 전체 부채 0이면 산출 근거 없음 → empty.
 */
function cleanupMomentumAxis(
  debtTrend: WeeklyReview["debtTrend"],
  momentumScale: number,
): LifeWheelAxis {
  if (debtTrend.length < 2) {
    return {
      id: "cleanup_momentum",
      label: "정리 모멘텀",
      score: null,
      confidence: "empty",
      detail: "모멘텀 산출에 최소 2일 필요",
    };
  }
  const firstLoad = totalDebtLoad(debtTrend[0]);
  const lastLoad = totalDebtLoad(debtTrend[debtTrend.length - 1]);
  if (firstLoad === 0 && lastLoad === 0) {
    return {
      id: "cleanup_momentum",
      label: "정리 모멘텀",
      score: null,
      confidence: "empty",
      detail: "부채 없음 — 모멘텀 없음",
    };
  }
  const improvement = firstLoad - lastLoad; // 양수 = 줄임(개선)
  const scale = momentumScale > 0 ? momentumScale : 1;
  const score = clampPct(50 + (improvement / scale) * 50);
  const confidence: LifeWheelConfidence = debtTrend.length < 3 ? "sparse" : "measured";
  const detail =
    improvement > 0
      ? `${improvement} 감소`
      : improvement < 0
        ? `${-improvement} 증가`
        : "변화 없음";
  return { id: "cleanup_momentum", label: "정리 모멘텀", score, confidence, detail };
}

/**
 * `WeeklyReview` → 7축 주간 작업 life-wheel. 순수 함수.
 *
 * 축: flow(캡처) · execution(완료) · promotion(승격) · pr_hygiene · routine · debt_health ·
 * cleanup_momentum. 근거 없는 축은 score=null + confidence="empty"(0과 구분)로 두고 overall 평균에서 제외.
 */
export function computeWeeklyLifeWheel(
  review: WeeklyReview,
  targets: LifeWheelTargets = DEFAULT_LIFE_WHEEL_TARGETS,
): WeeklyLifeWheel {
  const axes: LifeWheelAxis[] = [
    throughputAxis(
      "flow",
      "흐름 (캡처)",
      review.throughput.captured,
      targets.capture,
      targets.sparseFloor,
    ),
    throughputAxis(
      "execution",
      "실행 (완료)",
      review.throughput.completed,
      targets.completion,
      targets.sparseFloor,
    ),
    throughputAxis(
      "promotion",
      "산출 (승격)",
      review.throughput.promoted,
      targets.promotion,
      targets.sparseFloor,
    ),
    prHygieneAxis(review.prActivity.attentionNew, review.prActivity.resolved, targets.sparseFloor),
    routineAxis(review.routineAdherence.due, review.routineAdherence.done, targets.sparseFloor),
    debtHealthAxis(review.debtTrend, targets.debtTolerance),
    cleanupMomentumAxis(review.debtTrend, targets.momentumScale),
  ];

  const scored = axes.filter((a): a is LifeWheelAxis & { score: number } => a.score !== null);
  const overall = scored.length
    ? clampPct(scored.reduce((sum, a) => sum + a.score, 0) / scored.length)
    : null;

  return { axes, overall, measuredCount: scored.length };
}

/**
 * 인사이트 카드 입력 — 레이더에서 파생한 강점/취약/부채움직임/루틴(순수 함수).
 * 근거 없는 값은 `null`(오해 부르는 0/100 기본값 금지). best/weakest는 measured 축만 비교한다.
 */
export type LifeWheelInsights = {
  /** 점수 최고 축(score!==null 중). 전부 empty면 null. */
  best: LifeWheelAxis | null;
  /** 점수 최저 축(score!==null 중). measured 축이 2개 미만이면 best와 같을 수 있어 호출부에서 게이트. */
  weakest: LifeWheelAxis | null;
  /** 정리 모멘텀 축(부채 움직임). empty일 수 있음. */
  momentum: LifeWheelAxis | null;
  /** 루틴 이행 축. empty일 수 있음. */
  routine: LifeWheelAxis | null;
};

/** `WeeklyLifeWheel` → 인사이트 카드 입력. 순수·부수효과 없음. */
export function deriveLifeWheelInsights(wheel: WeeklyLifeWheel): LifeWheelInsights {
  let best: (LifeWheelAxis & { score: number }) | null = null;
  let weakest: (LifeWheelAxis & { score: number }) | null = null;
  for (const a of wheel.axes) {
    if (a.score === null) continue;
    const scored = a as LifeWheelAxis & { score: number };
    if (best === null || scored.score > best.score) best = scored;
    if (weakest === null || scored.score < weakest.score) weakest = scored;
  }
  return {
    best,
    weakest,
    momentum: wheel.axes.find((a) => a.id === "cleanup_momentum") ?? null,
    routine: wheel.axes.find((a) => a.id === "routine") ?? null,
  };
}
