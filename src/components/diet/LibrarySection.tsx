import { ChefHat, ChevronDown, ChevronUp, Plus, RotateCcw, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type {
  Food,
  FoodType,
  Recipe,
  RecipeIngredientInput,
  RecipeStepInput,
  TasteAxis,
} from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  localToday,
  useAddFoodAlias,
  useAddRecipeFeedback,
  useCookRecipe,
  useCreateRecipe,
  useFoods,
  useRecipeRevisions,
  useRecipes,
  useRecipeSuggestions,
  useRecipeTasteSummary,
  useRemoveFoodAlias,
  useRevertRecipe,
  useSetFoodArchived,
  useSetRecipeArchived,
  useUpdateRecipe,
  useUpsertFood,
} from "@/lib/query";

import { fmtG, fmtKcal, num, parseOptionalInt } from "./dietFormat";
import { FoodSelect } from "./FoodSelect";

const FOOD_TYPE_LABEL: Record<FoodType, string> = {
  ingredient: "원재료",
  product: "가공식품",
  dish: "요리",
};

export function LibrarySection() {
  return (
    <section className="diet-section" aria-label="식품·레시피 라이브러리">
      <FoodsPanel />
      <RecipesPanel />
    </section>
  );
}

// ── 식품 ──────────────────────────────────────────────────────────────

function FoodsPanel() {
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: foods } = useFoods(query, includeArchived);
  // 스냅샷 대신 id만 저장하고 라이브 쿼리에서 파생 — 열린 다이얼로그 안에서 별칭 추가/삭제가
  // invalidate → refetch로 즉시 칩에 반영된다(critic MAJOR-1: stale Food 스냅샷 금지).
  // 파생 원본은 패널 검색과 무관한 전체 목록 — 별칭 삭제로 검색 매치가 풀려도 다이얼로그가
  // 도중에 닫히지 않는다.
  const { data: allFoods } = useFoods("", true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = allFoods?.find((f) => f.id === editingId) ?? null;
  const [creating, setCreating] = useState(false);

  return (
    <div className="diet-panel">
      <div className="diet-toolbar">
        <h2 className="typo-body-strong">식품</h2>
        <div className="diet-toolbar-controls">
          <Input
            className="diet-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름/별칭 검색"
          />
          <label className="diet-check typo-caption-sm">
            <Checkbox
              checked={includeArchived}
              onCheckedChange={(v) => setIncludeArchived(v === true)}
            />
            보관 포함
          </label>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> 새 식품
          </Button>
        </div>
      </div>
      {foods == null || foods.length === 0 ? (
        <EmptyState className="diet-empty" title="식품 없음">
          영양 계산의 기준 데이터 — 100g당 값으로 등록한다.
        </EmptyState>
      ) : (
        <ul className="diet-food-list">
          <li className="diet-food-row diet-food-head typo-label-sm" aria-hidden>
            <span>이름</span>
            <span>분류</span>
            <span>kcal/100g</span>
            <span>P / F / C</span>
            <span>별칭</span>
          </li>
          {foods.map((food) => (
            <li key={food.id}>
              <button
                type="button"
                className={cn("diet-food-row diet-food-btn", food.archived && "is-archived")}
                onClick={() => setEditingId(food.id)}
              >
                <span className="typo-body-md">
                  {food.name}
                  {food.preparation && <span className="typo-micro"> ({food.preparation})</span>}
                  {food.archived && (
                    <Badge variant="outline" className="diet-archived">
                      보관
                    </Badge>
                  )}
                </span>
                <span className="typo-caption-sm">{FOOD_TYPE_LABEL[food.foodType]}</span>
                <span className="typo-label-sm">{Math.round(num(food.kcalPer100g))}</span>
                <span className="typo-caption-sm">
                  {Math.round(num(food.proteinGPer100g))} / {Math.round(num(food.fatGPer100g))} /{" "}
                  {Math.round(num(food.carbGPer100g))}
                </span>
                <span className="diet-alias-chips">
                  {food.aliases.map((alias) => (
                    <Badge key={alias} variant="outline">
                      {alias}
                    </Badge>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <FoodDialog
        open={creating || editing != null}
        food={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditingId(null);
          }
        }}
      />
    </div>
  );
}

function FoodDialog({
  open,
  food,
  onOpenChange,
}: {
  open: boolean;
  food: Food | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <FoodDialogBody key={food?.id ?? "new"} food={food} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

function FoodDialogBody({ food, onDone }: { food: Food | null; onDone: () => void }) {
  const upsert = useUpsertFood();
  const setArchived = useSetFoodArchived();
  const addAlias = useAddFoodAlias();
  const removeAlias = useRemoveFoodAlias();

  const [name, setName] = useState(food?.name ?? "");
  const [foodType, setFoodType] = useState<FoodType>(food?.foodType ?? "ingredient");
  const [preparation, setPreparation] = useState(food?.preparation ?? "");
  const [kcal, setKcal] = useState(food ? String(num(food.kcalPer100g)) : "");
  const [protein, setProtein] = useState(food ? String(num(food.proteinGPer100g)) : "");
  const [fat, setFat] = useState(food ? String(num(food.fatGPer100g)) : "");
  const [carb, setCarb] = useState(food ? String(num(food.carbGPer100g)) : "");
  const [serving, setServing] = useState(
    food?.defaultServingG != null ? String(num(food.defaultServingG)) : "",
  );
  const [aliasDraft, setAliasDraft] = useState("");

  const parseNum = (raw: string): number => {
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (upsert.isPending || name.trim().length === 0) return;
    await upsert.mutateAsync({
      id: food?.id ?? null,
      name: name.trim(),
      foodType,
      preparation: preparation.trim() || null,
      defaultServingG: serving.trim() === "" ? null : parseNum(serving),
      kcalPer100g: parseNum(kcal),
      proteinGPer100g: parseNum(protein),
      fatGPer100g: parseNum(fat),
      carbGPer100g: parseNum(carb),
      fiberGPer100g: food?.fiberGPer100g ?? null,
      sodiumMgPer100g: food?.sodiumMgPer100g ?? null,
      source: food?.source ?? null,
      sourceRef: food?.sourceRef ?? null,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>{food ? `식품 편집 — ${food.name}` : "새 식품"}</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">이름</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">분류</span>
            <Select value={foodType} onValueChange={(v) => setFoodType(v as FoodType)}>
              <SelectTrigger className="diet-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FOOD_TYPE_LABEL) as FoodType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {FOOD_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">조리 상태</span>
            <Input
              value={preparation}
              onChange={(e) => setPreparation(e.target.value)}
              placeholder="raw / cooked"
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">기본 1회분 (g)</span>
            <Input
              inputMode="numeric"
              value={serving}
              onChange={(e) => setServing(e.target.value)}
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">kcal /100g</span>
            <Input
              inputMode="numeric"
              value={kcal}
              onChange={(e) => setKcal(e.target.value)}
              required
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">단백질 g/100g</span>
            <Input
              inputMode="numeric"
              value={protein}
              onChange={(e) => setProtein(e.target.value)}
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">지방 g/100g</span>
            <Input inputMode="numeric" value={fat} onChange={(e) => setFat(e.target.value)} />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">탄수화물 g/100g</span>
            <Input inputMode="numeric" value={carb} onChange={(e) => setCarb(e.target.value)} />
          </label>
        </div>

        {food && (
          <div className="diet-field">
            <span className="typo-label-sm">별칭 (검색용)</span>
            <div className="diet-alias-editor">
              {food.aliases.map((alias) => (
                <Badge key={alias} variant="outline" className="diet-alias-chip">
                  {alias}
                  <button
                    type="button"
                    aria-label={`별칭 ${alias} 삭제`}
                    onClick={() => removeAlias.mutate(alias)}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              <Input
                className="diet-alias-input"
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                placeholder="별칭 추가"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={aliasDraft.trim().length === 0 || addAlias.isPending}
                onClick={async () => {
                  await addAlias.mutateAsync({ foodId: food.id, alias: aliasDraft.trim() });
                  setAliasDraft("");
                }}
              >
                추가
              </Button>
            </div>
          </div>
        )}

        <div className="diet-form-actions">
          {food && (
            <Button
              type="button"
              variant={food.archived ? "outline" : "destructiveOutline"}
              disabled={setArchived.isPending}
              onClick={async () => {
                await setArchived.mutateAsync({ id: food.id, archived: !food.archived });
                onDone();
              }}
            >
              {food.archived ? "복원" : "보관"}
            </Button>
          )}
          <Button type="submit" disabled={upsert.isPending}>
            저장
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

// ── 레시피 ────────────────────────────────────────────────────────────

function RecipesPanel() {
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: recipes } = useRecipes(query, includeArchived);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="diet-panel">
      <div className="diet-toolbar">
        <h2 className="typo-body-strong">레시피</h2>
        <div className="diet-toolbar-controls">
          <Input
            className="diet-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름 검색"
          />
          <label className="diet-check typo-caption-sm">
            <Checkbox
              checked={includeArchived}
              onCheckedChange={(v) => setIncludeArchived(v === true)}
            />
            보관 포함
          </label>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> 새 레시피
          </Button>
        </div>
      </div>
      <SuggestionStrip
        onPick={(recipeId) => {
          const picked = recipes?.find((r) => r.id === recipeId);
          if (picked != null) setEditing(picked);
        }}
      />
      {recipes == null || recipes.length === 0 ? (
        <EmptyState className="diet-empty" title="레시피 없음">
          재료(g)로 등록하면 영양은 식품 데이터에서 자동 계산된다.
        </EmptyState>
      ) : (
        <div className="diet-recipe-grid">
          {recipes.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className={cn("diet-recipe-card", recipe.archived && "is-archived")}
              onClick={() => setEditing(recipe)}
            >
              <span className="typo-body-strong">
                {recipe.name}
                {recipe.archived && (
                  <Badge variant="outline" className="diet-archived">
                    보관
                  </Badge>
                )}
              </span>
              <span className="typo-caption-sm">
                {num(recipe.servings)}인분
                {recipe.cookMinutes != null && ` · ${recipe.cookMinutes}분`} · 재료{" "}
                {recipe.ingredients.length}
              </span>
              <span className="typo-label-sm">
                1인분 {fmtKcal(recipe.perServing.kcal)} · P{" "}
                {Math.round(num(recipe.perServing.proteinG))}g
              </span>
            </button>
          ))}
        </div>
      )}
      <RecipeDialog
        open={creating || editing != null}
        recipe={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}

type DraftIngredient = {
  foodId: string | null;
  qtyG: string;
  /** 표기 수량 — 단위와 함께 입력하면 g은 커널이 환산한다(빈 값이면 qtyG를 그대로 쓴다). */
  qty: string;
  unit: string;
  toTaste: boolean;
  optional: boolean;
};

type DraftStep = { body: string; durationMinutes: string; note: string };

const EMPTY_INGREDIENT: DraftIngredient = {
  foodId: null,
  qtyG: "",
  qty: "",
  unit: "",
  toTaste: false,
  optional: false,
};

const EMPTY_STEP: DraftStep = { body: "", durationMinutes: "", note: "" };

/** 재료 입력 단위 후보 — 0075가 seed한 전역 환산과 같은 집합. */
const UNIT_OPTIONS = ["g", "ml", "tsp", "tbsp", "cup", "pinch", "ea", "slice", "clove"] as const;

const TASTE_AXIS_LABEL: Record<TasteAxis, string> = {
  salt: "간(소금)",
  spice: "매움",
  sweet: "단맛",
  sour: "산미",
  richness: "기름짐",
  doneness: "익힘",
};

function RecipeDialog({
  open,
  recipe,
  onOpenChange,
}: {
  open: boolean;
  recipe: Recipe | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <RecipeDialogBody
          key={recipe?.id ?? "new"}
          recipe={recipe}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

function RecipeDialogBody({ recipe, onDone }: { recipe: Recipe | null; onDone: () => void }) {
  const create = useCreateRecipe();
  const update = useUpdateRecipe();
  const setArchived = useSetRecipeArchived();

  const [name, setName] = useState(recipe?.name ?? "");
  const [servings, setServings] = useState(recipe ? String(num(recipe.servings)) : "1");
  const [cookMinutes, setCookMinutes] = useState(
    recipe?.cookMinutes != null ? String(recipe.cookMinutes) : "",
  );
  const [tags, setTags] = useState(recipe?.mealTags.join(", ") ?? "");
  const [sourceUrl, setSourceUrl] = useState(recipe?.sourceUrl ?? "");
  const [notes, setNotes] = useState(recipe?.notes ?? "");
  const [ingredients, setIngredients] = useState<DraftIngredient[]>(
    recipe != null && recipe.ingredients.length > 0
      ? recipe.ingredients.map((i) => ({
          foodId: i.foodId,
          qtyG: String(num(i.qtyG)),
          qty: i.qty != null ? String(num(i.qty)) : "",
          unit: i.unit ?? "",
          toTaste: i.toTaste,
          optional: i.optional,
        }))
      : [EMPTY_INGREDIENT],
  );
  const [steps, setSteps] = useState<DraftStep[]>(
    recipe != null && recipe.steps.length > 0
      ? recipe.steps.map((s) => ({
          body: s.body,
          durationMinutes: s.durationMinutes != null ? String(s.durationMinutes) : "",
          note: s.note ?? "",
        }))
      : [EMPTY_STEP],
  );

  const patchIngredient = (index: number, patch: Partial<DraftIngredient>) => {
    setIngredients((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const patchStep = (index: number, patch: Partial<DraftStep>) => {
    setSteps((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const moveStep = (index: number, delta: number) => {
    setSteps((prev) => {
      const next = prev.slice();
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const pending = create.isPending || update.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || name.trim().length === 0) return;
    const servingsN = Number(servings);
    if (!Number.isFinite(servingsN) || servingsN <= 0) return;
    const cleanIngredients: RecipeIngredientInput[] = ingredients
      .filter((row) => row.foodId != null)
      .map((row) => {
        // 단위 표기가 있으면 g은 백엔드 커널이 환산한다 — 프런트에서 환산표를 복제하지 않는다.
        const hasUnit = row.unit.trim().length > 0 && Number(row.qty) > 0;
        return {
          foodId: row.foodId as string,
          qtyG: hasUnit ? null : Number(row.qtyG),
          qty: hasUnit ? Number(row.qty) : null,
          unit: hasUnit ? row.unit.trim() : null,
          toTaste: row.toTaste,
          optional: row.optional,
          note: null,
        };
      })
      .filter((row) => row.qty != null || (row.qtyG != null && row.qtyG > 0));
    const cleanSteps: RecipeStepInput[] = steps
      .filter((row) => row.body.trim().length > 0)
      .map((row) => ({
        body: row.body.trim(),
        durationMinutes: parseOptionalInt(row.durationMinutes),
        note: row.note.trim() || null,
      }));
    const shared = {
      name: name.trim(),
      servings: servingsN,
      cookMinutes: parseOptionalInt(cookMinutes),
      mealTags: tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      sourceUrl: sourceUrl.trim() || null,
      yieldG: null,
      notes: notes.trim() || null,
      ingredients: cleanIngredients,
      steps: cleanSteps,
      changedBy: null,
    };
    if (recipe) {
      await update.mutateAsync({
        id: recipe.id,
        // 다이얼로그를 여는 동안 에이전트가 고쳤다면 덮어쓰지 않고 실패한다.
        expectedRevNo: recipe.revNo,
        changeSummary: null,
        ...shared,
      });
    } else {
      await create.mutateAsync(shared);
    }
    onDone();
  };

  return (
    <DialogContent className="diet-dialog diet-dialog-wide" aria-describedby={undefined}>
      <DialogTitle>{recipe ? `레시피 편집 — ${recipe.name}` : "새 레시피"}</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">이름</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">기준 인분</span>
            <Input
              inputMode="numeric"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
              required
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">조리 시간 (분)</span>
            <Input
              inputMode="numeric"
              value={cookMinutes}
              onChange={(e) => setCookMinutes(e.target.value)}
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">태그 (쉼표 구분)</span>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="dinner, pasta"
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">출처 링크</span>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://"
            />
          </label>
        </div>

        <div className="diet-field">
          <span className="typo-label-sm">재료 (전체 교체 저장)</span>
          <div className="diet-draftlines">
            {ingredients.map((row, i) => (
              // 재정렬 없는 append/patch 드래프트 — index key 안전.
              <div key={i} className="diet-draftline diet-draftline-ingredient">
                <FoodSelect
                  value={row.foodId}
                  onChange={(foodId) => patchIngredient(i, { foodId })}
                />
                <Input
                  inputMode="numeric"
                  value={row.qtyG}
                  onChange={(e) => patchIngredient(i, { qtyG: e.target.value })}
                  placeholder="g"
                  disabled={row.unit.trim().length > 0}
                />
                <Input
                  inputMode="decimal"
                  value={row.qty}
                  onChange={(e) => patchIngredient(i, { qty: e.target.value })}
                  placeholder="양"
                  aria-label="표기 수량"
                />
                <select
                  className="diet-unit-select typo-caption-sm"
                  value={row.unit}
                  aria-label="단위"
                  onChange={(e) => patchIngredient(i, { unit: e.target.value })}
                >
                  <option value="">g 직접</option>
                  {UNIT_OPTIONS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
                <label className="diet-check typo-caption-sm">
                  <Checkbox
                    checked={row.toTaste}
                    onCheckedChange={(v) => patchIngredient(i, { toTaste: v === true })}
                  />
                  간
                </label>
                <label className="diet-check typo-caption-sm">
                  <Checkbox
                    checked={row.optional}
                    onCheckedChange={(v) => patchIngredient(i, { optional: v === true })}
                  />
                  선택
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="재료 삭제"
                  onClick={() => setIngredients((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIngredients((prev) => [...prev, EMPTY_INGREDIENT])}
            >
              <Plus className="size-4" /> 재료 추가
            </Button>
          </div>
          <span className="typo-caption-sm diet-hint">
            단위를 고르면 g은 환산표(식품 전용 &gt; 전역)로 계산된다. 환산이 없는 단위는 저장이
            거부된다.
          </span>
        </div>

        <div className="diet-field">
          <span className="typo-label-sm">조리 단계</span>
          <div className="diet-draftlines">
            {steps.map((row, i) => (
              <div key={i} className="diet-draftline diet-draftline-step">
                <span className="diet-step-no typo-label-sm">{i + 1}</span>
                <Textarea
                  value={row.body}
                  onChange={(e) => patchStep(i, { body: e.target.value })}
                  rows={2}
                  placeholder="무엇을 하는가"
                />
                <Input
                  inputMode="numeric"
                  className="diet-step-minutes"
                  value={row.durationMinutes}
                  onChange={(e) => patchStep(i, { durationMinutes: e.target.value })}
                  placeholder="분"
                  aria-label="소요 분"
                />
                <Input
                  value={row.note}
                  onChange={(e) => patchStep(i, { note: e.target.value })}
                  placeholder="튜닝 메모"
                  aria-label="단계 메모"
                />
                <div className="diet-step-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="위로"
                    disabled={i === 0}
                    onClick={() => moveStep(i, -1)}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="아래로"
                    disabled={i === steps.length - 1}
                    onClick={() => moveStep(i, 1)}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="단계 삭제"
                    onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSteps((prev) => [...prev, EMPTY_STEP])}
            >
              <Plus className="size-4" /> 단계 추가
            </Button>
          </div>
        </div>

        <label className="diet-field">
          <span className="typo-label-sm">총평 메모</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>

        {recipe && (
          <p className="typo-caption-sm">
            rev {recipe.revNo} · 현재 재료 기준 전체 {fmtKcal(recipe.total.kcal)} · 1인분{" "}
            {fmtKcal(recipe.perServing.kcal)} · 재료 총량{" "}
            {fmtG(recipe.ingredients.reduce((sum, i) => sum + num(i.qtyG), 0))}
          </p>
        )}

        {recipe && <RecipeTuningPanel recipe={recipe} />}

        <div className="diet-form-actions">
          {recipe && (
            <Button
              type="button"
              variant={recipe.archived ? "outline" : "destructiveOutline"}
              disabled={setArchived.isPending}
              onClick={async () => {
                await setArchived.mutateAsync({ id: recipe.id, archived: !recipe.archived });
                onDone();
              }}
            >
              {recipe.archived ? "복원" : "보관"}
            </Button>
          )}
          <Button type="submit" disabled={pending}>
            저장
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/**
 * 반복 튜닝 패널 — 조리 기록 · 축별 맛 피드백 · 개정 이력/되돌리기.
 *
 * 폼(위 replace-all 저장)과 **분리된 즉시 액션**이다: 저장 버튼을 누르지 않아도 각각 독립적인
 * 사실 기록이고, 되돌리기는 새 리비전을 만들므로 폼 드래프트와 섞이면 안 된다.
 */
function RecipeTuningPanel({ recipe }: { recipe: Recipe }) {
  const { data: revisions } = useRecipeRevisions(recipe.id);
  const { data: taste } = useRecipeTasteSummary(recipe.id);
  const revert = useRevertRecipe();
  const cook = useCookRecipe();
  const feedback = useAddRecipeFeedback();

  const [cookServings, setCookServings] = useState(String(num(recipe.servings)));
  const [rating, setRating] = useState("");
  const [axes, setAxes] = useState<Partial<Record<TasteAxis, string>>>({});
  const [comment, setComment] = useState("");

  const axisValue = (axis: TasteAxis) => axes[axis] ?? "0";
  const submitFeedback = async () => {
    if (feedback.isPending) return;
    const delta = (axis: TasteAxis) => {
      const raw = axes[axis];
      if (raw == null || raw === "0") return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    await feedback.mutateAsync({
      recipeId: recipe.id,
      revNo: recipe.revNo,
      mealLogId: null,
      rating: parseOptionalInt(rating),
      saltDelta: delta("salt"),
      spiceDelta: delta("spice"),
      sweetDelta: delta("sweet"),
      sourDelta: delta("sour"),
      richnessDelta: delta("richness"),
      donenessDelta: delta("doneness"),
      comment: comment.trim() || null,
    });
    setAxes({});
    setRating("");
    setComment("");
  };

  return (
    <div className="diet-tuning">
      <div className="diet-tuning-block">
        <span className="typo-label-sm">조리 기록</span>
        <div className="diet-tuning-row">
          <Input
            inputMode="decimal"
            className="diet-tuning-servings"
            value={cookServings}
            onChange={(e) => setCookServings(e.target.value)}
            aria-label="조리 인분"
          />
          <span className="typo-caption-sm">인분</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={cook.isPending}
            onClick={() => {
              const servings = Number(cookServings);
              if (!Number.isFinite(servings) || servings <= 0) return;
              void cook.mutateAsync({
                recipeId: recipe.id,
                servings,
                date: localToday(),
                at: null,
                plannedMealId: null,
                consumePantry: true,
                satisfaction: null,
                fullness: null,
                note: null,
              });
            }}
          >
            <ChefHat className="size-4" /> 조리 (재고 차감 + 기록)
          </Button>
        </div>
        <span className="typo-caption-sm diet-hint">
          재료가 모자라면 아무것도 차감·기록되지 않는다. 간 맞춤·선택 재료는 조리를 막지 않는다.
        </span>
      </div>

      <div className="diet-tuning-block">
        <span className="typo-label-sm">먹어본 평가 (다음 튜닝 근거)</span>
        <div className="diet-tuning-axes">
          {(Object.keys(TASTE_AXIS_LABEL) as TasteAxis[]).map((axis) => (
            <label key={axis} className="diet-axis">
              <span className="typo-caption-sm">{TASTE_AXIS_LABEL[axis]}</span>
              <select
                className="diet-unit-select typo-caption-sm"
                value={axisValue(axis)}
                onChange={(e) => setAxes((prev) => ({ ...prev, [axis]: e.target.value }))}
              >
                <option value="-2">많이 부족</option>
                <option value="-1">부족</option>
                <option value="0">적당</option>
                <option value="1">과함</option>
                <option value="2">많이 과함</option>
              </select>
            </label>
          ))}
        </div>
        <div className="diet-tuning-row">
          <Input
            inputMode="numeric"
            className="diet-tuning-servings"
            value={rating}
            onChange={(e) => setRating(e.target.value)}
            placeholder="1-5"
            aria-label="만족도"
          />
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="한 줄 메모"
            aria-label="평가 메모"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={feedback.isPending}
            onClick={() => void submitFeedback()}
          >
            평가 저장
          </Button>
        </div>
        {taste != null && taste.hints.length > 0 && (
          <p className="typo-caption-sm">
            누적 제안:{" "}
            {taste.hints
              .map(
                (h) =>
                  `${TASTE_AXIS_LABEL[h.axis]} ${h.direction === "reduce" ? "줄이기" : "늘리기"}`,
              )
              .join(" · ")}
            {taste.avgRating != null && ` · 평균 ${taste.avgRating.toFixed(1)}점`}
          </p>
        )}
      </div>

      {revisions != null && revisions.length > 0 && (
        <div className="diet-tuning-block">
          <span className="typo-label-sm">개정 이력</span>
          <ul className="diet-revisions">
            {revisions.map((rev) => (
              <li key={rev.id} className="diet-revision">
                <span className="typo-caption-sm">
                  rev {rev.revNo} · {rev.changedBy === "agent" ? "에이전트" : "나"}
                  {rev.changeSummary != null && ` · ${rev.changeSummary}`}
                </span>
                {rev.revNo !== recipe.revNo && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={revert.isPending}
                    onClick={() =>
                      void revert.mutateAsync({
                        recipeId: recipe.id,
                        revNo: rev.revNo,
                        expectedRevNo: recipe.revNo,
                      })
                    }
                  >
                    <RotateCcw className="size-4" /> 되돌리기
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <span className="typo-caption-sm diet-hint">
            되돌리기도 새 리비전으로 남는다 — 되돌린 것을 다시 되돌릴 수 있다.
          </span>
        </div>
      )}
    </div>
  );
}

/** 지금 재고로 만들 수 있는 것 — 결정론 순위(재고 커버리지 · 유통기한 압력 · 목표 적합도). */
function SuggestionStrip({ onPick }: { onPick: (recipeId: string) => void }) {
  const today = localToday();
  const { data: suggestions } = useRecipeSuggestions(today, 5);
  if (suggestions == null || suggestions.length === 0) return null;
  return (
    <div className="diet-suggestions">
      <span className="typo-label-sm">지금 만들 수 있는 것</span>
      <div className="diet-suggestion-row">
        {suggestions.map((s) => (
          <button
            key={s.recipeId}
            type="button"
            className="diet-suggestion-card"
            onClick={() => onPick(s.recipeId)}
          >
            <span className="typo-body-strong">{s.name}</span>
            <span className="typo-caption-sm">
              재고 {Math.round(num(s.coveragePct))}%
              {s.earliestExpiry != null && ` · ${s.earliestExpiry}까지`}
            </span>
            {s.missing.length > 0 && (
              <span className="typo-caption-sm diet-suggestion-missing">
                부족: {s.missing.slice(0, 3).join(", ")}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
