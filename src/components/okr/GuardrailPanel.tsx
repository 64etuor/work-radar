import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

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
  const [label, setLabel] = useState("");
  const [areaKey, setAreaKey] = useState(firstArea);
  const [targetKind, setTargetKind] = useState<GuardrailTargetKind>("routine_count");
  const [targetValue, setTargetValue] = useState("3");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanLabel = label.trim();
    if (!cleanLabel) return;
    await upsertGuardrail.mutateAsync({
      id: null,
      quarter,
      areaKey,
      label: cleanLabel,
      targetKind,
      targetValue: parseNullableNumber(targetValue),
      unit: targetKind === "weekly_minutes" ? "분" : targetKind === "routine_count" ? "회" : null,
      sourceRoutineIds: [],
      sortRank: guardrails.length,
    });
    setLabel("");
  };

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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => deleteGuardrail.mutate(guardrail.id)}
              disabled={deleteGuardrail.isPending}
              aria-label={`${guardrail.label} 삭제`}
            >
              <Trash2 className="size-4" />
            </Button>
          </article>
        ))}
        {guardrails.length === 0 && (
          <div className="mission-empty-line typo-body-md">이번 분기 가드레일이 없습니다.</div>
        )}
      </div>
      <form className="mission-guardrail-form" onSubmit={submit}>
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="예: 주 3회 운동"
        />
        <Select value={areaKey} onValueChange={setAreaKey}>
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
          value={targetKind}
          onValueChange={(value) => setTargetKind(value as GuardrailTargetKind)}
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
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
          inputMode="decimal"
          className="mission-guardrail-value"
        />
        <Button type="submit" disabled={upsertGuardrail.isPending || label.trim().length === 0}>
          <Plus className="size-4" />
          추가
        </Button>
      </form>
    </section>
  );
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
