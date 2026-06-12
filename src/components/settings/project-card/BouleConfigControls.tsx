import { AlertTriangle, ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import type { BouleBudgetCaps_Deserialize, BouleConfigSettings_Serialize } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBouleConfig, useSetBouleConfig } from "@/lib/query";

import { Field, SectionLabel, Segmented } from "../SettingsKit";

type BouleConfigSettings = BouleConfigSettings_Serialize;
type BouleBudgetCaps = BouleBudgetCaps_Deserialize;
type BouleBudgetKey = keyof BouleBudgetCaps;
type BudgetDraft = Record<BouleBudgetKey, string>;
type BudgetParseResult = BouleBudgetCaps | null | "invalid";
type AdvancedDraft = {
  backends: string;
  routing: string;
  priceTable: string;
};
type BouleConfigPatch = Partial<
  Pick<BouleConfigSettings, "kind" | "autonomyLevel" | "reviewQuorum">
> & {
  budget?: BouleBudgetCaps | null;
  backends?: string | null;
  routing?: string | null;
  priceTable?: string | null;
};

const BUDGET_FIELDS: {
  key: BouleBudgetKey;
  label: string;
  integer: boolean;
  step: number;
}[] = [
  { key: "runTokenCap", label: "실행 토큰 한도", integer: true, step: 1 },
  { key: "stepTokenCap", label: "스텝 토큰 한도", integer: true, step: 1 },
  { key: "runCostCapUsd", label: "실행 비용 USD", integer: false, step: 0.01 },
  { key: "stepCostCapUsd", label: "스텝 비용 USD", integer: false, step: 0.01 },
];

const ADVANCED_FIELDS: { key: keyof AdvancedDraft; label: string }[] = [
  { key: "backends", label: "backends" },
  { key: "routing", label: "routing" },
  { key: "priceTable", label: "priceTable" },
];

function budgetDraftFrom(budget: BouleConfigSettings["budget"]): BudgetDraft {
  return {
    runTokenCap: budget?.runTokenCap == null ? "" : String(budget.runTokenCap),
    stepTokenCap: budget?.stepTokenCap == null ? "" : String(budget.stepTokenCap),
    runCostCapUsd: budget?.runCostCapUsd == null ? "" : String(budget.runCostCapUsd),
    stepCostCapUsd: budget?.stepCostCapUsd == null ? "" : String(budget.stepCostCapUsd),
  };
}

function budgetInputFrom(budget: BouleConfigSettings["budget"]): BouleBudgetCaps | null {
  if (!budget) return null;
  return {
    runTokenCap: budget.runTokenCap ?? null,
    stepTokenCap: budget.stepTokenCap ?? null,
    runCostCapUsd: budget.runCostCapUsd ?? null,
    stepCostCapUsd: budget.stepCostCapUsd ?? null,
  };
}

function parseBudgetValue(raw: string, integer: boolean): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return integer ? Math.trunc(n) : n;
}

function budgetFromDraft(draft: BudgetDraft): BudgetParseResult {
  const parsed = {
    runTokenCap: parseBudgetValue(draft.runTokenCap, true),
    stepTokenCap: parseBudgetValue(draft.stepTokenCap, true),
    runCostCapUsd: parseBudgetValue(draft.runCostCapUsd, false),
    stepCostCapUsd: parseBudgetValue(draft.stepCostCapUsd, false),
  };
  if (Object.values(parsed).includes("invalid")) return "invalid";
  const next: BouleBudgetCaps = parsed as BouleBudgetCaps;
  return Object.values(next).some((v) => v != null) ? next : null;
}

function prettyJson(value: unknown): string {
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function advancedDraftFrom(data: BouleConfigSettings | null | undefined): AdvancedDraft {
  return {
    backends: prettyJson(data?.backends),
    routing: prettyJson(data?.routing),
    priceTable: prettyJson(data?.priceTable),
  };
}

function advancedInputFromDraft(draft: AdvancedDraft) {
  return {
    backends: draft.backends.trim() === "" ? null : draft.backends,
    routing: draft.routing.trim() === "" ? null : draft.routing,
    priceTable: draft.priceTable.trim() === "" ? null : draft.priceTable,
  };
}

function advancedSeedKey(data: BouleConfigSettings | null | undefined): string | null {
  if (!data) return null;
  return JSON.stringify([data.backends ?? null, data.routing ?? null, data.priceTable ?? null]);
}

/** Per-repo Boule autonomy config (Slice 2) — edits the core knobs of a designated LOCAL repo's
 *  `.boule/boule.config.json`. Settings-only: these tune POST-acceptance autonomy; accept_plan /
 *  accept_spec stay HUMAN gates (INVARIANT #1). auto_plan/full OPEN that gate (test/dev) → warned. */
export function BouleConfigControls({
  repoId,
  onToast,
}: {
  repoId: string;
  onToast: (msg: string) => void;
}) {
  const cfg = useBouleConfig(repoId);
  const set = useSetBouleConfig();
  const data = cfg.data;
  const budgetSeed = data ? JSON.stringify(data.budget ?? null) : null;
  const advancedSeed = advancedSeedKey(data);

  if (cfg.isLoading || !data) return null;

  return (
    <BouleConfigDraftControls
      key={`${budgetSeed ?? ""}:${advancedSeed ?? ""}`}
      repoId={repoId}
      data={data}
      set={set}
      onToast={onToast}
    />
  );
}

function BouleConfigDraftControls({
  repoId,
  data,
  set,
  onToast,
}: {
  repoId: string;
  data: BouleConfigSettings;
  set: ReturnType<typeof useSetBouleConfig>;
  onToast: (msg: string) => void;
}) {
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>(() => budgetDraftFrom(data.budget));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedDraft, setAdvancedDraft] = useState<AdvancedDraft>(() => advancedDraftFrom(data));
  const [advancedError, setAdvancedError] = useState<string | null>(null);

  const buildInput = (patch: BouleConfigPatch) => {
    const currentAdvanced = advancedDraftFrom(data);
    return {
      repoId,
      kind: patch.kind ?? data.kind,
      autonomyLevel: patch.autonomyLevel ?? data.autonomyLevel,
      reviewQuorum: patch.reviewQuorum ?? data.reviewQuorum,
      budget: Object.prototype.hasOwnProperty.call(patch, "budget")
        ? (patch.budget ?? null)
        : budgetInputFrom(data.budget),
      backends: Object.prototype.hasOwnProperty.call(patch, "backends")
        ? (patch.backends ?? null)
        : advancedInputFromDraft(currentAdvanced).backends,
      routing: Object.prototype.hasOwnProperty.call(patch, "routing")
        ? (patch.routing ?? null)
        : advancedInputFromDraft(currentAdvanced).routing,
      priceTable: Object.prototype.hasOwnProperty.call(patch, "priceTable")
        ? (patch.priceTable ?? null)
        : advancedInputFromDraft(currentAdvanced).priceTable,
    };
  };

  // every knob change persists the full merged config (the write command requires all knobs).
  const save = (patch: BouleConfigPatch) => {
    const input = buildInput(patch);
    if (!input) return;
    set.mutate(input, { onError: () => onToast("Boule 설정 저장 실패") });
  };

  const onBudgetDraftChange = (key: BouleBudgetKey, value: string) => {
    const nextDraft = { ...budgetDraft, [key]: value };
    setBudgetDraft(nextDraft);
    const budget = budgetFromDraft(nextDraft);
    if (budget === "invalid") {
      onToast("Boule 예산 한도는 0 이상이어야 합니다");
      return;
    }
    save({ budget });
  };

  const opensGate = data.autonomyLevel === "auto_plan" || data.autonomyLevel === "full";
  const advancedDirty = JSON.stringify(advancedDraft) !== JSON.stringify(advancedDraftFrom(data));

  const saveAdvanced = () => {
    const advanced = advancedInputFromDraft(advancedDraft);
    const input = buildInput(advanced);
    if (!input) return;
    setAdvancedError(null);
    set.mutate(input, {
      onSuccess: () => onToast("Boule advanced 설정 저장됨"),
      onError: (e) => setAdvancedError(String(e)),
    });
  };

  return (
    <div className="border-border ml-7 flex flex-col gap-2 rounded-lg border border-dashed px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="text-muted-foreground size-3.5" />
        <SectionLabel>Boule 자율</SectionLabel>
        {!data.configExists && (
          <span className="text-muted-foreground text-xs">기본값 (미설정)</span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Field label="종류">
          <Segmented
            size="sm"
            value={data.kind}
            onChange={(kind) => save({ kind })}
            options={[
              { value: "personal", label: "개인" },
              { value: "work", label: "업무" },
            ]}
          />
        </Field>
        <Field label="자율 레벨">
          <Segmented
            size="sm"
            value={data.autonomyLevel}
            onChange={(autonomyLevel) => save({ autonomyLevel })}
            options={[
              { value: "manual", label: "manual" },
              { value: "dispatch", label: "dispatch" },
              { value: "auto_plan", label: "auto_plan" },
              { value: "full", label: "full" },
            ]}
          />
        </Field>
        <Field label="리뷰 정족수">
          <Segmented
            size="sm"
            value={String(data.reviewQuorum)}
            onChange={(q) => save({ reviewQuorum: Number(q) })}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
          />
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {BUDGET_FIELDS.map((field) => (
          <Field key={field.key} label={field.label}>
            <Input
              type="number"
              min={0}
              step={field.step}
              inputMode={field.integer ? "numeric" : "decimal"}
              value={budgetDraft[field.key]}
              className="h-8 w-full text-right"
              onChange={(e) => onBudgetDraftChange(field.key, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <div className="border-border bg-muted/15 rounded-lg border">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? (
            <ChevronDown className="text-muted-foreground size-3.5" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3.5" />
          )}
          <SectionLabel>ADVANCED JSON</SectionLabel>
          <span className="text-muted-foreground ml-auto text-xs">
            {[data.backends, data.routing, data.priceTable].filter(Boolean).length}/3
          </span>
        </button>
        {advancedOpen && (
          <div className="border-border flex flex-col gap-3 border-t p-3">
            {ADVANCED_FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                <Textarea
                  value={advancedDraft[field.key]}
                  onChange={(e) => {
                    setAdvancedDraft((draft) => ({
                      ...draft,
                      [field.key]: e.target.value,
                    }));
                    setAdvancedError(null);
                  }}
                  spellCheck={false}
                  className="min-h-[128px] resize-y font-mono text-xs leading-5"
                />
              </Field>
            ))}
            {advancedError && (
              <div className="flex items-start gap-1.5 text-xs text-[color:var(--destructive)]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{advancedError}</span>
              </div>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={saveAdvanced} disabled={!advancedDirty || set.isPending}>
                {set.isPending ? "저장 중…" : "Advanced 저장"}
              </Button>
            </div>
          </div>
        )}
      </div>
      {opensGate && (
        <div className="flex items-center gap-1.5 text-xs text-[color:var(--destructive)]">
          <AlertTriangle className="size-3.5 shrink-0" />
          auto_plan/full은 AI가 plan/spec을 자동 수락 (INVARIANT #1 개방) — 테스트·개발 전용.
        </div>
      )}
    </div>
  );
}
