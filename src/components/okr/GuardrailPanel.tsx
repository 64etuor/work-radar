import { Pencil, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useReducer } from "react";

import type { GuardrailTargetKind, LifeWheelTagConfig, OkrGuardrail } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeleteGuardrail, useUpsertGuardrail } from "@/lib/query";

const GUARDRAIL_KIND_LABEL: Record<GuardrailTargetKind, string> = {
  routine_count: "루틴 횟수",
  weekly_minutes: "주간 시간",
  manual_check: "체크",
};

type GuardrailDraft = {
  editing: OkrGuardrail | null;
  label: string;
  areaKey: string;
  targetKind: GuardrailTargetKind;
  targetValue: string;
};

type GuardrailDraftAction =
  | { type: "edit"; guardrail: OkrGuardrail }
  | { type: "reset"; firstArea: string }
  | { type: "setLabel"; label: string }
  | { type: "setAreaKey"; areaKey: string }
  | { type: "setTargetKind"; targetKind: GuardrailTargetKind }
  | { type: "setTargetValue"; targetValue: string };

export function GuardrailPanel({
  quarter,
  guardrails,
  tags,
}: {
  quarter: string;
  guardrails: OkrGuardrail[];
  tags: LifeWheelTagConfig[];
}) {
  const upsertGuardrail = useUpsertGuardrail();
  const deleteGuardrail = useDeleteGuardrail();
  const firstArea = tags.find((tag) => tag.enabled)?.id ?? "health";
  const enabledTags = enabledLifeWheelTags(tags);
  const [draft, dispatchDraft] = useReducer(
    guardrailDraftReducer,
    firstArea,
    initialGuardrailDraft,
  );

  const resetForm = () => {
    dispatchDraft({ type: "reset", firstArea });
  };

  const beginEdit = (guardrail: OkrGuardrail) => {
    dispatchDraft({ type: "edit", guardrail });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanLabel = draft.label.trim();
    if (!cleanLabel) return;
    await upsertGuardrail.mutateAsync({
      id: draft.editing?.id ?? null,
      quarter,
      areaKey: draft.areaKey,
      label: cleanLabel,
      targetKind: draft.targetKind,
      targetValue: parseNullableNumber(draft.targetValue),
      unit:
        draft.targetKind === "weekly_minutes"
          ? "분"
          : draft.targetKind === "routine_count"
            ? "회"
            : null,
      sourceRoutineIds: draft.editing?.sourceRoutineIds ?? [],
      sortRank: draft.editing?.sortRank ?? guardrails.length,
    });
    resetForm();
  };

  const pending = upsertGuardrail.isPending || deleteGuardrail.isPending;

  return (
    <section className="mission-life-panel">
      <div className="mission-panel-head">
        <div>
          <h2 className="mission-panel-title typo-title-sm">Guardrails</h2>
        </div>
      </div>
      <div className="mission-guardrail-list">
        {guardrails.map((guardrail) => (
          <article key={guardrail.id} className="mission-guardrail-item">
            <div>
              <strong className="typo-body-strong">{guardrail.label}</strong>
              <span className="mission-horizon-meta typo-mono-label">
                {labelForArea(guardrail.areaKey, tags)} ·{" "}
                {GUARDRAIL_KIND_LABEL[guardrail.targetKind]}
                {guardrail.targetValue != null
                  ? ` ${guardrail.targetValue}${guardrail.unit ?? ""}`
                  : ""}
              </span>
            </div>
            <div className="mission-row-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mission-row-action"
                onClick={() => beginEdit(guardrail)}
                disabled={pending}
                aria-label={`${guardrail.label} 수정`}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mission-row-action mission-row-action-danger"
                onClick={() => deleteGuardrail.mutate(guardrail.id)}
                disabled={pending}
                aria-label={`${guardrail.label} 삭제`}
              >
                <Trash2 className="size-5" />
              </Button>
            </div>
          </article>
        ))}
        {guardrails.length === 0 && (
          <div className="mission-empty-line typo-body-md">이번 분기 가드레일이 없습니다.</div>
        )}
      </div>
      <form className="mission-guardrail-form" onSubmit={submit}>
        <Input
          value={draft.label}
          onChange={(event) => dispatchDraft({ type: "setLabel", label: event.target.value })}
          placeholder="예: 주 3회 운동"
        />
        <Select
          value={draft.areaKey}
          onValueChange={(areaKey) => dispatchDraft({ type: "setAreaKey", areaKey })}
        >
          <SelectTrigger className="mission-guardrail-area">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {enabledTags.map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>
                {tag.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={draft.targetKind}
          onValueChange={(value) =>
            dispatchDraft({ type: "setTargetKind", targetKind: value as GuardrailTargetKind })
          }
        >
          <SelectTrigger className="mission-guardrail-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="routine_count">횟수</SelectItem>
            <SelectItem value="weekly_minutes">시간</SelectItem>
            <SelectItem value="manual_check">체크</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={draft.targetValue}
          onChange={(event) =>
            dispatchDraft({ type: "setTargetValue", targetValue: event.target.value })
          }
          inputMode="decimal"
          className="mission-guardrail-value"
        />
        <div className="mission-form-actions">
          {draft.editing && (
            <Button type="button" variant="ghost" size="sm" onClick={resetForm} disabled={pending}>
              <X className="size-4" />
              취소
            </Button>
          )}
          <Button type="submit" disabled={pending || draft.label.trim().length === 0}>
            <Plus className="size-4" />
            {draft.editing ? "저장" : "추가"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function initialGuardrailDraft(firstArea: string): GuardrailDraft {
  return {
    editing: null,
    label: "",
    areaKey: firstArea,
    targetKind: "routine_count",
    targetValue: "3",
  };
}

function guardrailDraftReducer(
  state: GuardrailDraft,
  action: GuardrailDraftAction,
): GuardrailDraft {
  switch (action.type) {
    case "edit":
      return {
        editing: action.guardrail,
        label: action.guardrail.label,
        areaKey: action.guardrail.areaKey,
        targetKind: action.guardrail.targetKind,
        targetValue:
          action.guardrail.targetValue == null ? "" : String(action.guardrail.targetValue),
      };
    case "reset":
      return initialGuardrailDraft(action.firstArea);
    case "setLabel":
      return { ...state, label: action.label };
    case "setAreaKey":
      return { ...state, areaKey: action.areaKey };
    case "setTargetKind":
      return { ...state, targetKind: action.targetKind };
    case "setTargetValue":
      return { ...state, targetValue: action.targetValue };
  }
}

function parseNullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function labelForArea(areaKey: string, tags: LifeWheelTagConfig[]): string {
  return tags.find((tag) => tag.id === areaKey)?.label ?? areaKey;
}

function enabledLifeWheelTags(tags: LifeWheelTagConfig[]): LifeWheelTagConfig[] {
  const enabled: LifeWheelTagConfig[] = [];
  for (const tag of tags) {
    if (tag.enabled) enabled.push(tag);
  }
  return enabled;
}
