import { useState } from "react";

import type { Project } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  calendarColorStyle,
  normalizeHexColor,
  PROJECT_CALENDAR_PALETTE,
  projectCalendarColors,
} from "@/lib/projectCalendarColor";
import { useSetProjectCalendarColor } from "@/lib/query";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

export function ProjectCalendarColorControl({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const colors = projectCalendarColors(project.id, project.calendarColor);
  const [draft, setDraft] = useState(colors.background);
  const saveColor = useSetProjectCalendarColor();
  const normalizedDraft = normalizeHexColor(draft);
  const savedBackground = normalizeHexColor(project.calendarColor ?? null) ?? colors.background;
  const preview = normalizedDraft ? projectCalendarColors(project.id, normalizedDraft) : colors;
  // 서버 값이 바뀌면 드래프트도 동기화.
  const [seededFrom, setSeededFrom] = useState<string | null | undefined>(undefined);
  if (project.calendarColor !== seededFrom) {
    setSeededFrom(project.calendarColor ?? null);
    setDraft(colors.background);
  }

  const persist = useDebouncedCallback((color: string | null) => {
    saveColor.mutate({ projectId: project.id, color });
  }, 400);

  // hex 텍스트 입력: debounced + 유효 hex 가드. 픽커/팔레트/리셋은 flushNow로 즉시 반영.
  const onTypeHex = (value: string) => {
    setDraft(value);
    const normalized = normalizeHexColor(value);
    if (normalized && normalized !== savedBackground) persist.run(normalized);
    else persist.cancel();
  };

  const setColorImmediate = (value: string) => {
    setDraft(value);
    const normalized = normalizeHexColor(value);
    if (normalized && normalized !== savedBackground) persist.flushNow(normalized);
  };

  const resetToDefault = () => {
    persist.flushNow(null);
    onToast("캘린더 색상 기본값으로 복원됨");
  };

  return (
    <div className="border-border rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="inline-flex min-w-[104px] items-center justify-center rounded-md border px-3 py-1.5 text-xs font-semibold"
          style={calendarColorStyle(preview.background, preview.foreground)}
        >
          {project.name}
        </span>
        <input
          type="color"
          value={normalizedDraft ?? colors.background}
          onChange={(e) => setColorImmediate(e.target.value)}
          aria-label="프로젝트 캘린더 색상"
          className="border-border h-8 w-10 cursor-pointer rounded border bg-transparent p-0.5"
        />
        <Input
          value={draft}
          onChange={(e) => onTypeHex(e.target.value)}
          className="h-8 w-[112px] font-mono text-xs"
          aria-label="프로젝트 캘린더 색상 hex"
        />
        <div className="flex items-center gap-1">
          {PROJECT_CALENDAR_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`색상 ${color}`}
              className="border-border size-5 rounded-full border"
              style={{ backgroundColor: color }}
              onClick={() => setColorImmediate(color)}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={resetToDefault}
            disabled={saveColor.isPending || !project.calendarColor}
          >
            기본값
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
        배경색만 저장합니다. 일정 제목과 캘린더명 글자색은 대비 기준으로 자동 조정됩니다.
      </p>
    </div>
  );
}
