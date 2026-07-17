import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Food, FoodType, Recipe, RecipeIngredientInput } from "@/bindings";
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
  useAddFoodAlias,
  useCreateRecipe,
  useFoods,
  useRecipes,
  useRemoveFoodAlias,
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

type DraftIngredient = { foodId: string | null; qtyG: string; optional: boolean };

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
  const [instructions, setInstructions] = useState(recipe?.instructions ?? "");
  const [ingredients, setIngredients] = useState<DraftIngredient[]>(
    recipe != null && recipe.ingredients.length > 0
      ? recipe.ingredients.map((i) => ({
          foodId: i.foodId,
          qtyG: String(num(i.qtyG)),
          optional: i.optional,
        }))
      : [{ foodId: null, qtyG: "", optional: false }],
  );

  const patchIngredient = (index: number, patch: Partial<DraftIngredient>) => {
    setIngredients((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const pending = create.isPending || update.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || name.trim().length === 0) return;
    const servingsN = Number(servings);
    if (!Number.isFinite(servingsN) || servingsN <= 0) return;
    const cleanIngredients: RecipeIngredientInput[] = ingredients
      .filter((row) => row.foodId != null && Number(row.qtyG) > 0)
      .map((row) => ({
        foodId: row.foodId as string,
        qtyG: Number(row.qtyG),
        optional: row.optional,
        note: null,
      }));
    const shared = {
      name: name.trim(),
      servings: servingsN,
      cookMinutes: parseOptionalInt(cookMinutes),
      mealTags: tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      instructions: instructions.trim() || null,
      ingredients: cleanIngredients,
    };
    if (recipe) {
      await update.mutateAsync({ id: recipe.id, ...shared });
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
                />
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
              onClick={() =>
                setIngredients((prev) => [...prev, { foodId: null, qtyG: "", optional: false }])
              }
            >
              <Plus className="size-4" /> 재료 추가
            </Button>
          </div>
        </div>

        <label className="diet-field">
          <span className="typo-label-sm">조리법</span>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
          />
        </label>

        {recipe && (
          <p className="typo-caption-sm">
            현재 재료 기준 전체 {fmtKcal(recipe.total.kcal)} · 1인분{" "}
            {fmtKcal(recipe.perServing.kcal)} · 재료 총량{" "}
            {fmtG(recipe.ingredients.reduce((sum, i) => sum + num(i.qtyG), 0))}
          </p>
        )}

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
