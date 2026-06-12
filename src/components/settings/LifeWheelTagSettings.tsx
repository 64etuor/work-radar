import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import type { LifeWheelTagConfig } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { DEFAULT_LIFE_WHEEL_TAGS, NEW_TAG_COLOR_CYCLE } from "@/lib/lifeWheelDefaults";
import { useLifeWheelTags, useSetLifeWheelTags } from "@/lib/query";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

import { Field, SectionLabel } from "./SettingsKit";

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nextColor(index: number): string {
  return NEW_TAG_COLOR_CYCLE[index % NEW_TAG_COLOR_CYCLE.length];
}

export function LifeWheelTagSettings({ onToast }: { onToast: (message: string) => void }) {
  const fieldId = useId();
  const newTagId = `${fieldId}-new-tag`;

  const tags = useLifeWheelTags();
  const save = useSetLifeWheelTags();
  // 텍스트 필드(라벨/hex)는 입력 중 떨림을 막기 위해 로컬 드래프트 + debounce.
  // 토글/픽커/추가/삭제/리셋은 즉시 persist — Save 버튼 없음.
  const [textDraft, setTextDraft] = useState<LifeWheelTagConfig[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const persist = useDebouncedCallback(
    (next: LifeWheelTagConfig[]) => save.mutate(next, { onSuccess: () => setTextDraft(null) }),
    400,
  );

  const draft = textDraft ?? tags.data ?? [];
  const enabledCount = draft.filter((tag) => tag.enabled).length;

  const updateTagText = (id: string, patch: Partial<LifeWheelTagConfig>) => {
    const next = draft.map((tag) => (tag.id === id ? { ...tag, ...patch } : tag));
    setTextDraft(next);
    persist.run(next);
  };

  const updateTagImmediate = (id: string, patch: Partial<LifeWheelTagConfig>) => {
    const next = draft.map((tag) => (tag.id === id ? { ...tag, ...patch } : tag));
    persist.flushNow(next);
  };

  const addTag = () => {
    const label = newLabel.trim();
    if (!label) return;
    const base = slugify(label) || `custom-${draft.length + 1}`;
    const used = new Set(draft.map((tag) => tag.id));
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    const next: LifeWheelTagConfig[] = [
      ...draft,
      {
        id,
        label,
        color: nextColor(draft.length),
        builtIn: false,
        enabled: true,
      },
    ];
    setNewLabel("");
    persist.flushNow(next);
  };

  const removeTag = (id: string) => {
    persist.flushNow(draft.filter((tag) => tag.id !== id));
  };

  const resetToDefaults = () => {
    persist.flushNow(DEFAULT_LIFE_WHEEL_TAGS.map((tag) => ({ ...tag })));
    setNewLabel("");
    onToast("Life Wheel 태그가 기본 팔레트로 초기화됨");
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="rounded-2xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SectionLabel>Life Wheel</SectionLabel>
            <h3 className="mt-1 text-base font-semibold">팔레트 태그</h3>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              보드 카드에서 쓰는 Life Wheel 팔레트의 표시 여부와 색상을 관리합니다. 변경 시 자동으로
              저장됩니다.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={resetToDefaults}
              disabled={save.isPending}
              className="gap-1.5"
              title="브랜드 기본 팔레트로 즉시 되돌립니다."
            >
              <RotateCcw className="size-4" />
              기본값으로 초기화
            </Button>
          </div>
        </div>
      </Card>

      <Card className="rounded-2xl p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="새 태그" htmlFor={newTagId}>
            <input
              id={newTagId}
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addTag();
              }}
              className="border-border bg-card focus:border-ring h-9 rounded-lg border px-3 text-sm outline-none"
              placeholder="예: 운동, 독서, 사이드프로젝트"
              aria-label="새 태그 이름"
            />
          </Field>
          <Button type="button" className="gap-1.5 self-end" onClick={addTag}>
            <Plus className="size-4" />
            추가
          </Button>
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        {tags.isLoading && (
          <Card className="text-muted-foreground rounded-2xl p-4 text-sm">불러오는 중...</Card>
        )}
        {draft.map((tag) => {
          const isLastEnabled = tag.enabled && enabledCount === 1;
          return (
            <Card key={tag.id} className="rounded-2xl p-3">
              <div className="grid items-center gap-3 sm:grid-cols-[auto_minmax(8rem,1fr)_8rem_auto_auto]">
                <button
                  type="button"
                  onClick={() => updateTagImmediate(tag.id, { enabled: !tag.enabled })}
                  disabled={isLastEnabled}
                  title={isLastEnabled ? "최소 한 개의 태그는 표시해야 합니다" : undefined}
                  className={cn(
                    "h-8 rounded-lg border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    tag.enabled
                      ? "border-border-strong bg-secondary text-foreground"
                      : "border-border bg-card text-muted-foreground",
                  )}
                >
                  {tag.enabled ? "표시" : "숨김"}
                </button>
                <input
                  value={tag.label}
                  onChange={(event) => updateTagText(tag.id, { label: event.target.value })}
                  className="border-border bg-card focus:border-ring h-9 rounded-lg border px-3 text-sm outline-none"
                  aria-label={`${tag.label} 태그 이름`}
                />
                <input
                  value={tag.color}
                  onChange={(event) => updateTagText(tag.id, { color: event.target.value })}
                  className="border-border bg-card focus:border-ring h-9 rounded-lg border px-3 font-mono text-xs outline-none"
                  aria-label={`${tag.label} 색상 코드`}
                />
                <input
                  type="color"
                  value={tag.color}
                  onChange={(event) => updateTagImmediate(tag.id, { color: event.target.value })}
                  className="border-border bg-card h-9 w-12 rounded-lg border p-1"
                  aria-label={`${tag.label} 색상`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground size-8 p-0"
                  onClick={() => removeTag(tag.id)}
                  disabled={tag.builtIn}
                  title={tag.builtIn ? "기본 태그는 삭제 대신 숨김 처리하세요" : "삭제"}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
