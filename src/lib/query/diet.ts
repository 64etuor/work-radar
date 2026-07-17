import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type AddPantryLotInput,
  commands,
  type CreateRecipeInput,
  type GroceryOrderStatus,
  type PantryEventKind,
  type ReceiveOrderLineInput,
  type RecordGroceryOrderInput,
  type SetDietGoalInput,
  type UpdateRecipeInput,
  type UpsertFoodInput,
} from "@/bindings";

import { pushMutationError, unwrap } from "./client";

export const dietKeys = {
  all: ["diet"] as const,
  daily: (date: string) => ["diet", "daily", date] as const,
  logs: (from: string, to: string) => ["diet", "logs", from, to] as const,
  plans: ["diet", "plans"] as const,
  planDetail: (id: string) => ["diet", "plan", id] as const,
  pantry: ["diet", "pantry"] as const,
  expiring: (today: string, withinDays: number) => ["diet", "expiring", today, withinDays] as const,
  shopping: (planId: string) => ["diet", "shopping", planId] as const,
  orders: (limit: number) => ["diet", "orders", limit] as const,
  foods: (query: string, includeArchived: boolean) =>
    ["diet", "foods", query, includeArchived] as const,
  recipes: (query: string, includeArchived: boolean) =>
    ["diet", "recipes", query, includeArchived] as const,
  goals: ["diet", "goals"] as const,
};

function invalidateDiet(qc: QueryClient) {
  // 도메인 전체 무효화 — diet 쿼리는 전부 로컬 SQLite라 재조회가 싸고, 재고↔장보기↔주문처럼
  // 파생이 얽힌 표면에서 부분 무효화가 놓치는 조합이 더 비싸다(frontend-shell 헬퍼 규율).
  return qc.invalidateQueries({ queryKey: dietKeys.all });
}

/** diet mutation 들이 공유하는 invalidate 헬퍼 — 인라인 invalidateQueries 금지. 모듈 내부 전용. */
function useInvalidateDiet() {
  const qc = useQueryClient();
  return () => invalidateDiet(qc);
}

// ── 히스토리(읽기 전용) ────────────────────────────────────────────────

export function useDailyDietNutrition(date: string) {
  return useQuery({
    queryKey: dietKeys.daily(date),
    queryFn: () => unwrap(commands.dailyDietNutrition(date)),
    enabled: date.length > 0,
    placeholderData: keepPreviousData,
  });
}

/** 주간 스트립용 — 여러 날짜의 일일 요약을 병렬 조회(로컬 SQLite라 저비용). */
export function useDailyDietNutritionRange(dates: readonly string[]) {
  return useQueries({
    queries: dates.map((date) => ({
      queryKey: dietKeys.daily(date),
      queryFn: () => unwrap(commands.dailyDietNutrition(date)),
    })),
  });
}

export function useMealLogs(from: string, to: string) {
  return useQuery({
    queryKey: dietKeys.logs(from, to),
    queryFn: () => unwrap(commands.listMealLogs(from, to)),
    enabled: from.length > 0 && to.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useMealPlans() {
  return useQuery({
    queryKey: dietKeys.plans,
    queryFn: () => unwrap(commands.listMealPlans()),
  });
}

export function useMealPlanDetail(id: string | null) {
  return useQuery({
    queryKey: dietKeys.planDetail(id ?? ""),
    queryFn: () => unwrap(commands.getMealPlan(id ?? "")),
    enabled: id != null && id.length > 0,
  });
}

export function useDietGoals() {
  return useQuery({
    queryKey: dietKeys.goals,
    queryFn: () => unwrap(commands.listDietGoals()),
  });
}

/** 목표 새 버전 추가(append-only) — 사람 결정 레일(MCP 표면에 없음, 앱이 유일한 입력면). */
export function useSetDietGoal() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: SetDietGoalInput) => unwrap(commands.setDietGoal(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

// ── 재고 ──────────────────────────────────────────────────────────────

export function usePantry() {
  return useQuery({
    queryKey: dietKeys.pantry,
    queryFn: () => unwrap(commands.listPantry()),
  });
}

export function useExpiringPantry(today: string, withinDays: number) {
  return useQuery({
    queryKey: dietKeys.expiring(today, withinDays),
    queryFn: () => unwrap(commands.expiringPantry(today, withinDays)),
    enabled: today.length > 0,
  });
}

export function useAddPantryLot() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: AddPantryLotInput) => unwrap(commands.addPantryLot(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useConsumePantry() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({
      foodId,
      qtyG,
      reason,
    }: {
      foodId: string;
      qtyG: number;
      reason: string | null;
    }) => unwrap(commands.consumePantry(foodId, qtyG, null, reason)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useAdjustPantryLot() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({
      lotId,
      newRemainingG,
      reason,
    }: {
      lotId: string;
      newRemainingG: number;
      reason: string | null;
    }) => unwrap(commands.adjustPantryLot(lotId, newRemainingG, reason)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useWastePantryLot() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({
      lotId,
      qtyG,
      kind,
      reason,
    }: {
      lotId: string;
      qtyG: number | null;
      kind: PantryEventKind;
      reason: string | null;
    }) => unwrap(commands.wastePantryLot(lotId, qtyG, kind, reason)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

// ── 장보기 / 주문 ─────────────────────────────────────────────────────

export function useDietShoppingList(planId: string | null) {
  return useQuery({
    queryKey: dietKeys.shopping(planId ?? ""),
    queryFn: () => unwrap(commands.dietShoppingList(planId ?? "")),
    enabled: planId != null && planId.length > 0,
  });
}

export function useGroceryOrders(limit: number) {
  return useQuery({
    queryKey: dietKeys.orders(limit),
    queryFn: () => unwrap(commands.listGroceryOrders(limit)),
  });
}

export function useRecordGroceryOrder() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: RecordGroceryOrderInput) => unwrap(commands.recordGroceryOrder(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useSetGroceryOrderStatus() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: GroceryOrderStatus }) =>
      unwrap(commands.setGroceryOrderStatus(id, status)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useSetOrderLineFood() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({ lineId, foodId }: { lineId: string; foodId: string | null }) =>
      unwrap(commands.setOrderLineFood(lineId, foodId)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useReceiveOrderLine() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: ReceiveOrderLineInput) => unwrap(commands.receiveOrderLine(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

// ── 라이브러리(식품·레시피) ───────────────────────────────────────────

export function useFoods(query: string, includeArchived: boolean) {
  return useQuery({
    queryKey: dietKeys.foods(query, includeArchived),
    queryFn: () => unwrap(commands.listFoods(query.length > 0 ? query : null, includeArchived)),
    placeholderData: keepPreviousData,
  });
}

export function useUpsertFood() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: UpsertFoodInput) => unwrap(commands.upsertFood(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useSetFoodArchived() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      unwrap(commands.setFoodArchived(id, archived)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useAddFoodAlias() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({ foodId, alias }: { foodId: string; alias: string }) =>
      unwrap(commands.addFoodAlias(foodId, alias)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useRemoveFoodAlias() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (alias: string) => unwrap(commands.removeFoodAlias(alias)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useRecipes(query: string, includeArchived: boolean) {
  return useQuery({
    queryKey: dietKeys.recipes(query, includeArchived),
    queryFn: () => unwrap(commands.listRecipes(query.length > 0 ? query : null, includeArchived)),
    placeholderData: keepPreviousData,
  });
}

export function useCreateRecipe() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: CreateRecipeInput) => unwrap(commands.createRecipe(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useUpdateRecipe() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: (input: UpdateRecipeInput) => unwrap(commands.updateRecipe(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}

export function useSetRecipeArchived() {
  const invalidate = useInvalidateDiet();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      unwrap(commands.setRecipeArchived(id, archived)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("diet", e, "식단"),
  });
}
