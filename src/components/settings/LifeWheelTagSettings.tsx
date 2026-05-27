import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import type { LifeWheelTagConfig } from "@/bindings";
import { useLifeWheelTags, useSetLifeWheelTags } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Field, SectionLabel } from "./SettingsKit";

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nextColor(index: number): string {
  const colors = ["#0f9f6e", "#1863dc", "#ff7759", "#d94f70", "#6f63d9", "#0f7a8a", "#9b6a2f"];
  return colors[index % colors.length];
}

export function LifeWheelTagSettings({ onToast }: { onToast: (message: string) => void }) {
  const tags = useLifeWheelTags();
  const save = useSetLifeWheelTags();
  const [draftOverride, setDraftOverride] = useState<LifeWheelTagConfig[] | null>(null);
  const [newLabel, setNewLabel] = useState("");

  const draft = useMemo(() => draftOverride ?? tags.data ?? [], [draftOverride, tags.data]);

  const enabledCount = useMemo(() => draft.filter((tag) => tag.enabled).length, [draft]);

  const updateDraft = (updater: (current: LifeWheelTagConfig[]) => LifeWheelTagConfig[]) => {
    setDraftOverride((current) => updater(current ?? tags.data ?? []));
  };

  const updateTag = (id: string, patch: Partial<LifeWheelTagConfig>) => {
    updateDraft((current) => current.map((tag) => (tag.id === id ? { ...tag, ...patch } : tag)));
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
    updateDraft((current) => [
      ...current,
      {
        id,
        label,
        color: nextColor(current.length),
        builtIn: false,
        enabled: true,
      },
    ]);
    setNewLabel("");
  };

  const removeTag = (id: string) => {
    updateDraft((current) => current.filter((tag) => tag.id !== id));
  };

  const persist = () => {
    save.mutate(draft, {
      onSuccess: () => {
        setDraftOverride(null);
        onToast("Life Wheel 태그 설정 저장됨");
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="rounded-2xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SectionLabel>Life Wheel</SectionLabel>
            <h3 className="mt-1 text-base font-semibold">팔레트 태그</h3>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              보드 카드에서 쓰는 Life Wheel 팔레트의 표시 여부와 색상을 관리합니다.
            </p>
          </div>
          <Button onClick={persist} disabled={save.isPending || enabledCount === 0}>
            {save.isPending ? "저장 중..." : "저장"}
          </Button>
        </div>
      </Card>

      <Card className="rounded-2xl p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="새 태그">
            <input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addTag();
              }}
              className="border-border bg-card focus:border-ring h-9 rounded-lg border px-3 text-sm outline-none"
              placeholder="예: 운동, 독서, 사이드프로젝트"
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
        {draft.map((tag) => (
          <Card key={tag.id} className="rounded-2xl p-3">
            <div className="grid items-center gap-3 sm:grid-cols-[auto_minmax(8rem,1fr)_8rem_auto_auto]">
              <button
                type="button"
                onClick={() => updateTag(tag.id, { enabled: !tag.enabled })}
                className={cn(
                  "h-8 rounded-lg border px-3 text-xs font-medium transition-colors",
                  tag.enabled
                    ? "border-border-strong bg-secondary text-foreground"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {tag.enabled ? "표시" : "숨김"}
              </button>
              <input
                value={tag.label}
                onChange={(event) => updateTag(tag.id, { label: event.target.value })}
                className="border-border bg-card focus:border-ring h-9 rounded-lg border px-3 text-sm outline-none"
              />
              <input
                value={tag.color}
                onChange={(event) => updateTag(tag.id, { color: event.target.value })}
                className="border-border bg-card focus:border-ring h-9 rounded-lg border px-3 font-mono text-xs outline-none"
              />
              <input
                type="color"
                value={tag.color}
                onChange={(event) => updateTag(tag.id, { color: event.target.value })}
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
        ))}
      </div>
    </div>
  );
}
