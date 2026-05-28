/**
 * Today×Timeline 캘린더 선택 popover(PR 5 Task 4, 스펙 §6.5).
 *
 * 트레이 → 캔버스 drop 시 해당 signal의 project에 `default_write_calendar_id`가 없거나,
 * 프로젝트 매핑이 없는 routine drop 시 캘린더 픽업을 사용자에게 묻는다.
 * "기본 캘린더로 저장" 체크 시 `setProjectDefaultWriteCalendar`로 영속(다음 drop부터 묻지 않음).
 */
import { useMemo, useState } from "react";

import type { Project, SelectedCalendar } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProjects, useSetProjectDefaultWriteCalendar } from "@/lib/query";

type Props = {
  open: boolean;
  /** picker 트리거 위치(보통 캔버스 drop 좌표). */
  anchor: { x: number; y: number } | null;
  /** signal의 project (none이면 후보 비어 보임 — 사용자가 cancel하면 picker 호출자가 resolve(null)). */
  signalProjectId: string | null;
  onPick: (calendarId: string) => void;
  onClose: () => void;
};

function safeParse(json: string | null | undefined): SelectedCalendar[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is SelectedCalendar =>
        typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}

export function CalendarPickerPopover({ open, anchor, signalProjectId, onPick, onClose }: Props) {
  const projectsQ = useProjects();
  const setDefault = useSetProjectDefaultWriteCalendar();
  const [picked, setPicked] = useState<string | null>(null);
  // 안전 기본값: 사용자가 의식적으로 체크해야 영속 저장 — 첫 picker에서 무의식 저장 방지.
  const [saveDefault, setSaveDefault] = useState<boolean>(false);

  const project: Project | undefined = useMemo(() => {
    if (!signalProjectId) return undefined;
    return (projectsQ.data ?? []).find((p) => p.id === signalProjectId);
  }, [projectsQ.data, signalProjectId]);

  const candidates = useMemo(
    () => safeParse(project?.googleCalendarIds ?? null),
    [project?.googleCalendarIds],
  );

  if (!open || !anchor) return null;

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>
        <span
          style={{
            position: "fixed",
            left: anchor.x,
            top: anchor.y,
            width: 1,
            height: 1,
          }}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent className="w-[280px] space-y-2" align="start">
        <div className="text-sm font-semibold">캘린더 선택</div>
        {!project && (
          <div className="text-muted-foreground text-xs">
            연결된 프로젝트가 없어요. 트레이 항목의 프로젝트를 먼저 지정하세요.
          </div>
        )}
        {project && candidates.length === 0 && (
          <div className="text-muted-foreground text-xs">
            이 프로젝트에 선택된 Google 캘린더가 없어요. 설정에서 먼저 선택하세요.
          </div>
        )}
        {candidates.map((c) => {
          const active = picked === c.id;
          return (
            <button
              key={c.id}
              type="button"
              className={`w-full rounded px-2 py-1 text-left text-xs transition-colors ${
                active ? "bg-wr-accent-soft" : "hover:bg-wr-bg-soft"
              }`}
              onClick={() => setPicked(c.id)}
            >
              {c.summary || c.id}
            </button>
          );
        })}
        {candidates.length > 0 && (
          <label className="flex items-center gap-2 pt-1 text-xs">
            <input
              type="checkbox"
              aria-label="기본 캘린더로 저장"
              checked={saveDefault}
              onChange={(e) => setSaveDefault(e.target.checked)}
            />
            기본 캘린더로 저장
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            size="sm"
            disabled={!picked || setDefault.isPending}
            onClick={async () => {
              if (!picked) return;
              if (saveDefault && project) {
                try {
                  await setDefault.mutateAsync({
                    projectId: project.id,
                    calendarId: picked,
                  });
                } catch {
                  // 저장 실패해도 1회성 picker 결과는 그대로 onPick으로 전달(graceful).
                }
              }
              onPick(picked);
            }}
          >
            적용
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
