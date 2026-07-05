import { Link2, Repeat } from "lucide-react";
import { useState } from "react";

import type { KeyResult, Weekday } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  localToday,
  useCreateRoutine,
  useRoutineTracking,
  useSetKeyResultRoutine,
} from "@/lib/query";

const WEEKDAYS: { key: Weekday; label: string }[] = [
  { key: "mon", label: "월" },
  { key: "tue", label: "화" },
  { key: "wed", label: "수" },
  { key: "thu", label: "목" },
  { key: "fri", label: "금" },
  { key: "sat", label: "토" },
  { key: "sun", label: "일" },
];

/**
 * KR ↔ 루틴 연결 컨트롤(수치형 KR 전용). 연결하면 진행이 루틴 완료에서 자동 파생되어
 * KR 값 입력·주간 체크인이 사라진다 — 입력은 매일 루틴 체크 한 곳으로 수렴.
 * 기존 루틴 선택 또는 KR 제목으로 새 루틴 생성(활성 구간=이 분기, 매주/매일).
 */
export function RoutineLinkControl({
  kr,
  quarterStart,
  quarterEnd,
}: {
  kr: KeyResult;
  quarterStart: string;
  quarterEnd: string;
}) {
  const [open, setOpen] = useState(false);
  const routines = useRoutineTracking(localToday(), 1);
  const setRoutine = useSetKeyResultRoutine();
  const createRoutine = useCreateRoutine();
  const [days, setDays] = useState<Weekday[]>([]);
  const [title, setTitle] = useState(kr.title);
  const pending = setRoutine.isPending || createRoutine.isPending;

  const link = (routineId: string | null) =>
    setRoutine.mutate({ id: kr.id, routineId }, { onSuccess: () => setOpen(false) });

  const createAndLink = () => {
    const clean = title.trim();
    if (!clean) return;
    createRoutine.mutate(
      {
        title: clean,
        freq: days.length === 0 || days.length === 7 ? "daily" : "weekly",
        weekdays: days,
        anchorDate: null,
        startDate: quarterStart,
        endDate: quarterEnd,
        timeOfDay: null,
        reminderOffsetMin: null,
        area: null,
        kind: null,
        monthlyPattern: null,
        monthlyNthWeek: null,
        durationMin: null,
      },
      { onSuccess: (routine) => link(routine.id) },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={kr.routineId ? "secondary" : "ghost"}
          size="sm"
          className="mission-kr-routine-btn"
          title={
            kr.routineId
              ? `루틴 연결됨: ${kr.routine?.title ?? "루틴"} — 진행이 루틴 체크에서 자동 집계`
              : "루틴 연결 — 매일 루틴 체크만 하면 KR 진행이 자동 집계"
          }
        >
          <Repeat className="size-3.5" />
          {kr.routineId ? (kr.routine?.title ?? "루틴") : "루틴"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="mission-routine-popover" align="end">
        <div className="mission-popover-head">
          <span className="typo-title-sm">루틴 연결</span>
          <span className="mission-muted typo-caption-sm">체크 = 자동 진행</span>
        </div>

        {kr.routineId && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => link(null)}
          >
            연결 해제 (수동 입력으로)
          </Button>
        )}

        <div className="mission-routine-list">
          {(routines.data ?? [])
            .filter((routine) => routine.id !== kr.routineId)
            .map((routine) => (
              <button
                key={routine.id}
                type="button"
                className="mission-routine-item"
                disabled={pending}
                onClick={() => link(routine.id)}
              >
                <Link2 className="size-3.5" aria-hidden />
                <span className="typo-body-md">{routine.title}</span>
              </button>
            ))}
          {(routines.data ?? []).length === 0 && (
            <span className="mission-muted typo-body-md">활성 루틴이 없습니다.</span>
          )}
        </div>

        <div className="mission-routine-new">
          <span className="typo-label-sm">새 루틴 만들기 (이 분기 동안)</span>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="새 루틴 제목"
          />
          <div className="mission-routine-days" aria-label="요일 (없으면 매일)">
            {WEEKDAYS.map((day) => (
              <label key={day.key} className="mission-check-row">
                <Checkbox
                  checked={days.includes(day.key)}
                  onCheckedChange={(checked) =>
                    setDays((current) =>
                      checked === true
                        ? [...current, day.key]
                        : current.filter((d) => d !== day.key),
                    )
                  }
                />
                <span className="typo-caption-sm">{day.label}</span>
              </label>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={pending || title.trim().length === 0}
            onClick={createAndLink}
          >
            만들고 연결
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
