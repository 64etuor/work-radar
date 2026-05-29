/**
 * 루틴 행의 Google Calendar 동기화 토글 (PR 2b-2).
 *
 * 루틴은 자신의 kind(개인/업무)와 같은 kind의 프로젝트에 매핑된다(ADR-0005). 후보 캘린더는
 * 그 프로젝트들이 설정에서 이미 선택한 `googleCalendarIds`(로컬 JSON) — 네트워크 호출 없음
 * (CalendarPickerPopover 패턴 미러). 선택 시 enable IPC가 kind 일치를 백엔드에서 재검증한다.
 */
import { CalendarCheck, CalendarPlus } from "lucide-react";
import { useMemo, useState } from "react";

import type { Project, RoutineToday } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { routineSyncCandidates, routineSyncedLabel } from "@/lib/routineSync";

type Props = {
  routine: RoutineToday;
  projects: Project[];
  onEnable: (routineId: string, projectId: string, calendarId: string) => void;
  onDisable: (routineId: string) => void;
  busy?: boolean;
};

export function RoutineSyncButton({ routine, projects, onEnable, onDisable, busy }: Props) {
  const [open, setOpen] = useState(false);
  const synced = routine.googleCalendarId != null;

  // 루틴 kind와 같은 kind의 프로젝트가 설정에서 고른 캘린더들 = sync 후보(순수 로직 — routineSync.ts).
  const candidates = useMemo(
    () => routineSyncCandidates(projects, routine.kind),
    [projects, routine.kind],
  );

  const syncedLabel = useMemo(
    () => routineSyncedLabel(candidates, routine.googleCalendarId),
    [candidates, routine.googleCalendarId],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("ract", synced && "synced")}
          title={synced ? "Google 동기화 중" : "Google 캘린더 동기화"}
          aria-label={synced ? "Google 동기화 설정" : "Google 캘린더 동기화"}
          aria-pressed={synced}
          disabled={busy}
        >
          {synced ? <CalendarCheck className="size-3.5" /> : <CalendarPlus className="size-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] space-y-2" align="end">
        <div className="text-sm font-semibold">Google 캘린더 동기화</div>

        {synced ? (
          <>
            <div className="text-muted-foreground text-xs">
              <span className="text-wr-fg">{syncedLabel}</span> 캘린더에 동기화 중입니다.
            </div>
            <div className="flex justify-end pt-1">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  onDisable(routine.id);
                  setOpen(false);
                }}
              >
                동기화 해제
              </Button>
            </div>
          </>
        ) : routine.kind == null ? (
          <div className="text-muted-foreground text-xs">
            먼저 이 루틴의 개인/업무 구분을 지정하세요 (태그 편집).
          </div>
        ) : candidates.length === 0 ? (
          <div className="text-muted-foreground text-xs">
            연결된 {routine.kind === "work" ? "업무" : "개인"} 프로젝트에 선택된 Google 캘린더가
            없어요. 설정에서 먼저 선택하세요.
          </div>
        ) : (
          candidates.map((c) => (
            <button
              key={`${c.projectId}:${c.id}`}
              type="button"
              className="hover:bg-wr-bg-soft w-full rounded px-2 py-1 text-left text-xs transition-colors"
              disabled={busy}
              onClick={() => {
                onEnable(routine.id, c.projectId, c.id);
                setOpen(false);
              }}
            >
              {c.summary || c.id}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
